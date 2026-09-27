(() => {
  "use strict";

  const mapData = window.GRAND_THEATRE_MAP;
  const seatSelectionEnabled = ["verified", "user-authorized-release"].includes(mapData.seatDataStatus);
  const categoryInfo = {
    general: { name: "一般席", color: "#b7b7b7" },
    orchestra: { name: "樂池座位席", color: "#d4d4d4" },
    wheelchair: { name: "輪椅席", color: "#00a3e9" },
    companion: { name: "陪同席", color: "#2167b7" },
    staff: { name: "前台服務人員席", color: "#ffd61e" }
  };
  const specialSeatLabels = { wheelchair: "輪椅席", companion: "輪陪席" };
  const defaultTicketOptions = [
    { id: "full", name: "全票" },
    { id: "concession", name: "優待票" },
    { id: "student", name: "學生票" }
  ];
  const canvas = document.getElementById("seats-photo");
  const context = canvas.getContext("2d");
  const container = document.getElementById("seat-map-container");
  const status = document.getElementById("seat-map-status");
  const seats = Array.isArray(mapData.seats) ? mapData.seats : [];
  const seatById = new Map(seats.map(seat => [seat.id, seat]));
  const cart = new Map();
  const soldSeatIds = new Set(seats.filter(seat => seat.status === "sold").map(seat => seat.id));
  let previousCartSize = 0;

  const svgNamespace = "http://www.w3.org/2000/svg";
  const seatFrameById = new Map();
  const originalFrameStyles = new Map();
  let svgDocument = null;
  let mapImage = null;
  let mapObjectUrl = null;
  let stateRenderRevision = 0;
  let initialMapLoaded = false;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const view = { scale: 1, tx: 0, ty: 0, fitScale: 1 };
  const buttonZoomFactor = 1.5;
  const wheelZoomFactor = 1.2;
  const pointers = new Map();
  let gesture = null;
  let framePending = false;

  function ticketOptionsForSeat(seat) {
    const configured = mapData.ticketOptionsByCategory?.[seat.category];
    if (!Array.isArray(configured)) return defaultTicketOptions;
    return configured.filter(option =>
      option && typeof option.id === "string" && option.id &&
      typeof option.name === "string" && option.name
    );
  }

  function ticketOptionLabel(option) {
    return Number.isFinite(option.price)
      ? `${option.name}：NT$ ${option.price.toLocaleString()}`
      : option.name;
  }

  function canvasRect() {
    return canvas.getBoundingClientRect();
  }

  function resizeCanvas() {
    const rect = canvasRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    drawSeatMap();
  }

  function fitToContainer() {
    const rect = canvasRect();
    const scale = Math.min(rect.width / mapData.width, rect.height / mapData.height);
    view.fitScale = scale;
    view.scale = scale;
    view.tx = (rect.width - mapData.width * scale) / 2;
    view.ty = (rect.height - mapData.height * scale) / 2;
    scheduleDraw();
  }

  function scheduleDraw() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      drawSeatMap();
    });
  }

  function setSeatFrameState(frame, originalStyle, state) {
    const overrides = state === "sold"
      ? "fill:#DCDCDC"
      : state === "selected"
        ? "fill:#FFF9CF;stroke:#F6061B"
        : "";
    const style = [originalStyle, overrides].filter(Boolean).join(";");
    if (style) frame.setAttribute("style", style);
    else frame.removeAttribute("style");
  }

  function renderSeatMapSvg() {
    if (!svgDocument) return;
    for (const seat of seats) {
      const frameId = seat.frameId || seat.id;
      const frame = seatFrameById.get(frameId);
      if (!frame) continue;
      const originalStyle = originalFrameStyles.get(frameId);
      const state = soldSeatIds.has(seat.id)
        ? "sold"
        : cart.has(seat.id)
          ? "selected"
          : "";
      setSeatFrameState(frame, originalStyle, state);
    }

    const serializedSvg = new XMLSerializer().serializeToString(svgDocument.documentElement);
    const objectUrl = URL.createObjectURL(new Blob([serializedSvg], { type: "image/svg+xml;charset=utf-8" }));
    const revision = ++stateRenderRevision;
    const nextImage = new Image();
    nextImage.onload = () => {
      if (revision !== stateRenderRevision) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      if (mapObjectUrl) URL.revokeObjectURL(mapObjectUrl);
      mapObjectUrl = objectUrl;
      mapImage = nextImage;
      if (!initialMapLoaded) {
        initialMapLoaded = true;
        resizeCanvas();
        fitToContainer();
        status.textContent = seatSelectionEnabled && seats.length
          ? `已載入 ${seats.length} 個座位 · 點選座位框選位；任意位置拖曳，滾輪或＋/−縮放`
          : seats.length
            ? `已載入 ${seats.length} 個座位候選資料，但 metadata 尚未驗證；暫不可選位。`
            : "PDF 原貌底圖已載入；座位互動資料待完成。可拖曳、縮放與重置。";
      } else {
        scheduleDraw();
      }
    };
    nextImage.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      if (revision === stateRenderRevision) status.textContent = "座位狀態圖載入失敗。";
    };
    nextImage.src = objectUrl;
  }

  function loadSeatMapSvg() {
    try {
      const source = window.GRAND_THEATRE_SVG_SOURCE;
      if (typeof source !== "string" || !source) throw new Error("SVG 來源資料尚未載入");
      const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
      if (parsed.querySelector("parsererror")) throw new Error("SVG 格式無法解析");
      svgDocument = parsed;
      const frames = Array.from(svgDocument.getElementsByTagNameNS(svgNamespace, "rect"))
        .filter(frame => (frame.getAttribute("class") || "").split(/\s+/).includes("gt-seat-frame"));
      frames.forEach(frame => {
        const seatId = frame.getAttribute("data-gt-seat-id");
        if (!seatId) return;
        seatFrameById.set(seatId, frame);
        originalFrameStyles.set(seatId, frame.getAttribute("style"));
      });
      if (seatFrameById.size !== seats.length || seats.some(seat => !seatFrameById.has(seat.frameId || seat.id))) {
        throw new Error(`座位資料 ${seats.length} 席，SVG 座框 ${seatFrameById.size} 席`);
      }
      renderSeatMapSvg();
    } catch (error) {
      status.textContent = `底圖載入失敗：${error.message}`;
    }
  }

  function drawSpecialSeatLabels() {
    const wheelchairSeats = seats.filter(seat => seat.category === "wheelchair");
    const companionSeats = seats.filter(seat => seat.category === "companion");
    const staffSeats = seats.filter(seat => seat.category === "staff");
    if (!wheelchairSeats.length) return;

    const wheelchairFontSize = Math.min(
      8,
      Math.max(...wheelchairSeats.map(seat => seat.w * view.scale * 0.22))
    );

    context.save();
    context.fillStyle = "#c0392b";
    context.strokeStyle = "#fff";
    context.textAlign = "center";
    context.textBaseline = "bottom";
    context.font = `bold ${wheelchairFontSize / view.scale}px sans-serif`;
    context.lineWidth = 1.2 / view.scale;

    // 輪椅席依國家音樂廳標示方式逐席標註。
    for (const seat of wheelchairSeats) {
      const x = seat.x + seat.w / 2;
      const y = seat.y - 2 / view.scale;
      context.strokeText("輪椅席", x, y);
      context.fillText("輪椅席", x, y);
    }

    // 工作席分散在不同排，每席上方各標示一次。
    for (const seat of staffSeats) {
      const x = seat.x + seat.w / 2;
      const y = seat.y - 2 / view.scale;
      context.strokeText("工作席", x, y);
      context.fillText("工作席", x, y);
    }

    // 輪陪席左右各一組，各標示一次；以組內中間座位定位，放在輪陪席列上緣。
    const sortedCompanionSeats = companionSeats.sort((a, b) => a.x - b.x);
    let group = [];
    const drawCompanionLabel = () => {
      if (!group.length) return;
      const anchor = group[Math.floor(group.length / 2)];
      const x = (group[0].x + group[group.length - 1].x + group[group.length - 1].w) / 2;
      const y = anchor.y - 2 / view.scale;
      context.strokeText("輪陪席", x, y);
      context.fillText("輪陪席", x, y);
      group = [];
    };

    for (const seat of sortedCompanionSeats) {
      const previous = group[group.length - 1];
      if (previous && seat.x - (previous.x + previous.w) > 80) drawCompanionLabel();
      group.push(seat);
    }
    drawCompanionLabel();
    context.restore();
  }

  function drawSeatMap() {
    if (!mapImage?.complete || !mapImage.naturalWidth) return;
    context.save();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    context.translate(view.tx, view.ty);
    context.scale(view.scale, view.scale);
    context.drawImage(mapImage, 0, 0, mapData.width, mapData.height);
    drawSpecialSeatLabels();
    context.restore();


  }

  function localPoint(clientX, clientY) {
    const rect = canvasRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function screenToWorld(clientX, clientY) {
    const point = localPoint(clientX, clientY);
    return { x: (point.x - view.tx) / view.scale, y: (point.y - view.ty) / view.scale };
  }

  function hitTestSeat(x, y) {
    let insideSeat = null;
    let insideDistance = Infinity;
    for (const seat of seats) {
      const centerX = seat.x + seat.w / 2;
      const centerY = seat.y + seat.h / 2;
      const distance = (x - centerX) ** 2 + (y - centerY) ** 2;
      if (x >= seat.x && x <= seat.x + seat.w && y >= seat.y && y <= seat.y + seat.h && distance < insideDistance) {
        insideDistance = distance;
        insideSeat = seat;
      }
    }
    return insideSeat;
  }

  function toggleSeat(seat) {
    if (!seatSelectionEnabled) {
      status.textContent = "座位資料尚未完成驗證，暫不可選位。";
      return;
    }
    if (soldSeatIds.has(seat.id)) {
      window.alert("此座位已售完！");
      return;
    }
    if (seat.category === "staff" || seat.selectable === false) {
      status.textContent = seat.category === "staff"
        ? "此為工作人員席，不開放選位。"
        : "此座位目前不可選擇。";
      return;
    }
    if (cart.has(seat.id)) {
      cart.delete(seat.id);
    } else {
      const options = ticketOptionsForSeat(seat);
      if (!options.length) {
        status.textContent = "此類座位尚未設定票種，暫不可選位。";
        return;
      }
      cart.set(seat.id, options[0].id);
    }
    updateSidebar();
    renderSeatMapSvg();
  }

  function seatDisplayName(seat) {
    const categoryName = categoryInfo[seat.category]?.name || seat.category;
    const rowNumber = Number(seat.row);
    const sideFloor = {
      "2R": "2樓", "2L": "2樓", "3R": "2樓", "3L": "2樓",
      "4R": "4樓", "4L": "4樓", "5R": "4樓", "5L": "4樓"
    }[seat.section];
    if (sideFloor) {
      return `${sideFloor} ${seat.section}排 ${String(seat.number).padStart(2, "0")}號`;
    }
    if (seat.section === "4樓" && rowNumber >= 1 && rowNumber <= 8) {
      return `4樓 ${seat.row} 排 ${seat.number} 號`;
    }
    if (seat.section === "MAIN" && rowNumber >= 1 && rowNumber <= 33) {
      return `2樓 ${seat.row}排 ${seat.number}號`;
    }
    if (seat.section === "MAIN" && ["general", "orchestra"].includes(seat.category)) {
      return `${seat.row} 排・${seat.number} 號・${categoryName}`;
    }
    const sectionName = seat.section === "MAIN" ? "大劇院" : seat.section;
    return `${sectionName} · ${seat.row}排 · ${seat.number}號 · ${categoryName}`;
  }

  function updateSidebar() {
    const content = document.getElementById("sidebar-content");
    const cartCount = document.getElementById("cart-toggle-count");
    const checkout = document.getElementById("btn-checkout");
    const sidebar = document.getElementById("sidebar");
    const groups = new Map();
    let total = 0;
    let pricesKnown = true;

    cart.forEach((optionId, seatId) => {
      const seat = seatById.get(seatId);
      if (!seat) return;
      const group = groups.get(seat.category) || [];
      group.push({ seat, optionId });
      groups.set(seat.category, group);
    });

    if (cart.size && previousCartSize === 0) sidebar.classList.add("active");
    if (!cart.size) sidebar.classList.remove("active");
    previousCartSize = cart.size;

    content.replaceChildren();
    if (!cart.size) {
      const empty = document.createElement("p");
      empty.style.cssText = "text-align:center;color:#999;margin-top:50px";
      empty.textContent = "尚未選擇座位";
      content.appendChild(empty);
    }

    const categoriesToRender = seatSelectionEnabled
      ? Object.keys(categoryInfo).filter(category => seats.some(seat => seat.category === category))
      : Array.from(groups.keys());
    for (const category of categoriesToRender) {
      const items = groups.get(category) || [];
      const type = categoryInfo[category] || { name: category, color: "#999" };
      const categorySeats = seats.filter(seat => seat.category === category);
      const selectableSeats = categorySeats.filter(seat => seat.selectable !== false);
      const remainingCount = selectableSeats.filter(seat => !soldSeatIds.has(seat.id)).length;
      const availabilitySummary = category === "staff" && selectableSeats.length === 0
        ? `固定席 ${categorySeats.length}`
        : `剩餘座位：${remainingCount}`;
      const group = document.createElement("div");
      group.className = "zone-group";
      const header = document.createElement("div");
      header.className = "zone-header";
      header.innerHTML = `<span><i class="legend-color" style="display:inline-block;background:${type.color};margin-right:8px"></i>${type.name}</span><span class="stat-count">${availabilitySummary} · 已選 ${items.length}</span>`;
      group.appendChild(header);
      const list = document.createElement("div");
      list.className = "zone-items";

      items.forEach(({ seat, optionId }) => {
        const card = document.createElement("div");
        card.className = "cart-item";
        card.style.borderLeftColor = type.color;
        const headerRow = document.createElement("div");
        headerRow.className = "cart-item-header";
        const name = document.createElement("span");
        name.textContent = seatDisplayName(seat);
        const remove = document.createElement("button");
        remove.className = "cart-item-remove";
        remove.type = "button";
        remove.textContent = "✕ 移除";
        remove.addEventListener("click", () => toggleSeat(seat));
        headerRow.append(name, remove);
        card.appendChild(headerRow);

        const select = document.createElement("select");
        select.className = "ticket-select";
        const availableOptions = ticketOptionsForSeat(seat);
        const selectedOptionId = availableOptions.some(option => option.id === optionId)
          ? optionId
          : availableOptions[0]?.id;
        if (selectedOptionId && selectedOptionId !== optionId) cart.set(seat.id, selectedOptionId);
        if (!availableOptions.length) {
          const emptyOption = document.createElement("option");
          emptyOption.textContent = "尚未設定票種";
          select.appendChild(emptyOption);
          select.disabled = true;
        }
        availableOptions.forEach(option => {
          const element = document.createElement("option");
          element.value = option.id;
          element.textContent = ticketOptionLabel(option);
          element.selected = option.id === selectedOptionId;
          select.appendChild(element);
        });
        select.addEventListener("change", () => {
          cart.set(seat.id, select.value);
          updateSidebar();
        });
        card.appendChild(select);
        list.appendChild(card);
      });
      group.appendChild(list);
      content.appendChild(group);
    }

    cart.forEach((optionId, seatId) => {
      const seat = seatById.get(seatId);
      const option = seat && ticketOptionsForSeat(seat).find(item => item.id === optionId);
      if (!option || !Number.isFinite(option.price) || option.price < 0) pricesKnown = false;
      else total += option.price;
    });
    document.getElementById("total-price").textContent = pricesKnown ? `NT$ ${total.toLocaleString()}` : "待活動設定";
    cartCount.textContent = String(cart.size);
    cartCount.style.display = cart.size ? "flex" : "none";
    checkout.disabled = !cart.size || !pricesKnown;
    syncCartToggleButton();
  }

  function syncCartToggleButton() {
    const open = document.getElementById("sidebar").classList.contains("active");
    document.getElementById("cart-toggle-btn").style.display = open ? "none" : "flex";
  }

  window.toggleSidebar = () => {
    document.getElementById("sidebar").classList.toggle("active");
    syncCartToggleButton();
  };

  function clampScale(scale) {
    return Math.max(view.fitScale, Math.min(scale, view.fitScale * 8));
  }

  function zoomAt(clientX, clientY, factor) {
    const point = localPoint(clientX, clientY);
    const worldX = (point.x - view.tx) / view.scale;
    const worldY = (point.y - view.ty) / view.scale;
    const nextScale = clampScale(view.scale * factor);
    view.tx = point.x - worldX * nextScale;
    view.ty = point.y - worldY * nextScale;
    view.scale = nextScale;
    scheduleDraw();
  }

  function pointerMidpoint() {
    const points = Array.from(pointers.values());
    return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
  }

  function pointerDistance() {
    const points = Array.from(pointers.values());
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  }

  function bindEvents() {
    function pointIsInsideMap(clientX, clientY) {
      const rect = container.getBoundingClientRect();
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    }

    function eventIsOnMap(event) {
      return event.target instanceof Node && container.contains(event.target);
    }

    window.addEventListener("pointerdown", event => {
      if (!eventIsOnMap(event) || !pointIsInsideMap(event.clientX, event.clientY)) return;
      if (event.target?.closest?.(".map-controls")) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      container.setPointerCapture(event.pointerId);
      const point = localPoint(event.clientX, event.clientY);
      pointers.set(event.pointerId, { ...point, startX: point.x, startY: point.y, moved: false });
      if (pointers.size === 1) {
        gesture = { type: "pan", startX: point.x, startY: point.y, tx: view.tx, ty: view.ty, moved: false };
      } else if (pointers.size === 2) {
        const mid = pointerMidpoint();
        gesture = {
          type: "pinch",
          distance: Math.max(1, pointerDistance()),
          scale: view.scale,
          worldX: (mid.x - view.tx) / view.scale,
          worldY: (mid.y - view.ty) / view.scale,
          moved: true
        };
      }
    }, true);

    window.addEventListener("pointermove", event => {
      if (!pointers.has(event.pointerId)) return;
      event.preventDefault();
      const point = localPoint(event.clientX, event.clientY);
      pointers.set(event.pointerId, { ...pointers.get(event.pointerId), x: point.x, y: point.y });
      if (pointers.size >= 2 && gesture?.type === "pinch") {
        const mid = pointerMidpoint();
        const scale = clampScale(gesture.scale * pointerDistance() / gesture.distance);
        view.scale = scale;
        view.tx = mid.x - gesture.worldX * scale;
        view.ty = mid.y - gesture.worldY * scale;
        scheduleDraw();
      } else if (pointers.size === 1 && gesture?.type === "pan") {
        const deltaX = point.x - gesture.startX;
        const deltaY = point.y - gesture.startY;
        if (Math.abs(deltaX) + Math.abs(deltaY) > 4) {
          gesture.moved = true;
          container.classList.add("is-panning");
        }
        view.tx = gesture.tx + deltaX;
        view.ty = gesture.ty + deltaY;
        scheduleDraw();
      }
    }, true);

    function finishPointer(event, allowSeatSelection) {
      const start = pointers.get(event.pointerId);
      if (allowSeatSelection && start && pointers.size === 1 && gesture?.type === "pan" && !gesture.moved) {
        const point = screenToWorld(event.clientX, event.clientY);
        const seat = hitTestSeat(point.x, point.y);
        if (seat) toggleSeat(seat);
      }
      pointers.delete(event.pointerId);
      if (pointers.size === 1) {
        const [id, point] = pointers.entries().next().value;
        gesture = { type: "pan", startX: point.x, startY: point.y, tx: view.tx, ty: view.ty, moved: true };
      } else if (!pointers.size) {
        gesture = null;
        container.classList.remove("is-panning");
      }
    }
    window.addEventListener("pointerup", event => finishPointer(event, true), true);
    window.addEventListener("pointercancel", event => finishPointer(event, false), true);

    document.getElementById("zoom-in-btn").addEventListener("click", () => {
      const rect = canvasRect();
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, buttonZoomFactor);
    });
    document.getElementById("zoom-out-btn").addEventListener("click", () => {
      const rect = canvasRect();
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / buttonZoomFactor);
    });
    document.getElementById("reset-btn").addEventListener("click", fitToContainer);
    window.addEventListener("wheel", event => {
      if (!eventIsOnMap(event) || !pointIsInsideMap(event.clientX, event.clientY)) return;
      if (event.target?.closest?.(".map-controls")) return;
      event.preventDefault();
      const atFitScale = view.scale <= view.fitScale * (1 + Number.EPSILON);
      const zoomIn = atFitScale || event.deltaY < 0;
      zoomAt(event.clientX, event.clientY, zoomIn ? wheelZoomFactor : 1 / wheelZoomFactor);
    }, { passive: false, capture: true });
    document.getElementById("btn-checkout").addEventListener("click", () => {
      window.alert("座位已加入購物車；此頁尚未連接售票結帳服務。");
    });
    window.addEventListener("resize", () => {
      resizeCanvas();
      fitToContainer();
    });
  }

  window.exportSeatDebug = function exportSeatDebug() {
    if (!mapImage?.complete || !mapImage.naturalWidth) return;
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = mapData.width;
    exportCanvas.height = mapData.height;
    const exportContext = exportCanvas.getContext("2d");
    exportContext.drawImage(mapImage, 0, 0, mapData.width, mapData.height);
    for (const seat of seats) {
      exportContext.beginPath();
      exportContext.rect(seat.x, seat.y, seat.w, seat.h);
      exportContext.strokeStyle = "rgba(0,120,255,.9)";
      exportContext.lineWidth = 3;
      exportContext.stroke();
      exportContext.fillStyle = "rgba(180,0,255,.22)";
      exportContext.fill();
    }
    const link = document.createElement("a");
    link.download = "grand-theatre-all-hotspots.png";
    link.href = exportCanvas.toDataURL("image/png");
    link.click();
  };

  window.exportSeatMapRender = function exportSeatMapRender() {
    const imageAspect = mapImage ? mapImage.naturalWidth / mapImage.naturalHeight : 0;
    const mapAspect = mapData.width / mapData.height;
    if (
      !mapImage?.complete ||
      !mapImage.naturalWidth ||
      !mapImage.naturalHeight ||
      Math.abs(imageAspect - mapAspect) > 0.001
    ) {
      throw new Error("大劇院座位圖尚未載入，或底圖比例與座位資料不符。");
    }
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = Math.ceil(mapData.width);
    exportCanvas.height = Math.ceil(mapData.height);
    const exportContext = exportCanvas.getContext("2d");
    exportContext.imageSmoothingEnabled = false;
    exportContext.drawImage(mapImage, 0, 0);
    const link = document.createElement("a");
    link.download = "grand-theatre-final-render.png";
    link.href = exportCanvas.toDataURL("image/png");
    link.click();
  };

  function initialize() {
    bindEvents();
    updateSidebar();
    loadSeatMapSvg();
  }

  window.addEventListener("DOMContentLoaded", initialize, { once: true });
})();

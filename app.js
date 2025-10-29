const REFRESH_INTERVAL_MS = 5000;
const FRAME_LAG_COUNT = 1;
const MAX_PENDING_FRAMES = 3;
const MIN_ANIMATION_DURATION_MS = REFRESH_INTERVAL_MS;
const MAX_ANIMATION_DURATION_MS = REFRESH_INTERVAL_MS * 3;
const API_BASE_URL = "https://retro.umoiq.com/service/publicXMLFeed";
const AGENCY_TAG = "ttc";
const MAP_STATUS_ID = "map-status";
const ROADMAP_STYLES = [
  {
    featureType: "poi",
    stylers: [{ visibility: "off" }],
  },
];

let map;

class VehicleFetcher {
  constructor() {
    this.lastTime = null;
  }

  reset() {
    this.lastTime = null;
  }

  async fetchVehicle(vehicleId) {
    const url = new URL(API_BASE_URL);
    url.searchParams.set("command", "vehicleLocation");
    url.searchParams.set("a", AGENCY_TAG);
    url.searchParams.set("v", vehicleId);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Failed to fetch vehicle ${vehicleId}`);
    }

    const text = await response.text();
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, "text/xml");
    const vehicleNode = xml.querySelector("vehicle");

    if (!vehicleNode) {
      return null;
    }

    return {
      id: vehicleNode.getAttribute("id"),
      routeTag: vehicleNode.getAttribute("routeTag"),
      heading: parseFloat(vehicleNode.getAttribute("heading") || "0"),
      lat: parseFloat(vehicleNode.getAttribute("lat")),
      lon: parseFloat(vehicleNode.getAttribute("lon")),
      predictable: vehicleNode.getAttribute("predictable") !== "false",
      secsSinceReport: parseInt(
        vehicleNode.getAttribute("secsSinceReport") || "0",
        10
      ),
      speedKmHr: parseFloat(vehicleNode.getAttribute("speedKmHr") || "0"),
    };
  }

  async fetchUpdates() {
    const url = new URL(API_BASE_URL);
    url.searchParams.set("command", "vehicleLocations");
    url.searchParams.set("a", AGENCY_TAG);
    url.searchParams.set("t", this.lastTime ?? "0");

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error("Failed to fetch vehicle updates");
    }

    const text = await response.text();
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, "text/xml");

    const lastTimeNode = xml.querySelector("lastTime");
    const nextTime = lastTimeNode?.getAttribute("time");
    if (nextTime) {
      this.lastTime = nextTime;
    }

    const vehicleNodes = Array.from(xml.querySelectorAll("vehicle"));
    const vehicles = vehicleNodes
      .map((vehicleNode) => ({
        id: vehicleNode.getAttribute("id"),
        routeTag: vehicleNode.getAttribute("routeTag"),
        heading: parseFloat(vehicleNode.getAttribute("heading") || "0"),
        lat: parseFloat(vehicleNode.getAttribute("lat")),
        lon: parseFloat(vehicleNode.getAttribute("lon")),
        predictable: vehicleNode.getAttribute("predictable") !== "false",
        secsSinceReport: parseInt(
          vehicleNode.getAttribute("secsSinceReport") || "0",
          10
        ),
        speedKmHr: parseFloat(vehicleNode.getAttribute("speedKmHr") || "0"),
      }))
      .filter((vehicle) => vehicle.id && Number.isFinite(vehicle.lat));

    return {
      vehicles,
      lastTime: this.lastTime,
    };
  }
}

function normalizeHeading(value) {
  let heading = value % 360;
  if (heading < 0) {
    heading += 360;
  }
  return heading;
}

function shortestHeadingDelta(start, end) {
  let delta = end - start;
  if (delta > 180) {
    delta -= 360;
  } else if (delta < -180) {
    delta += 360;
  }
  return delta;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getScaleForZoom(zoom) {
  if (!Number.isFinite(zoom)) {
    return 1;
  }

  const minScale = 0.18;
  const maxScale = 1.5;
  const referenceZoom = 8;
  const growthFactor = 1.28;

  const scale =
    minScale * Math.pow(growthFactor, Math.max(zoom - referenceZoom, -10));
  return clamp(scale, minScale, maxScale);
}

function getTimestamp() {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}

function interpolateLatLng(start, end, fraction, googleMaps) {
  const lat = start.lat() + (end.lat() - start.lat()) * fraction;
  const lng = start.lng() + (end.lng() - start.lng()) * fraction;
  return new googleMaps.LatLng(lat, lng);
}

function createVehicleOverlayClass(googleMaps) {
  return class VehicleOverlay extends googleMaps.OverlayView {
    constructor(mapInstance, vehicle, options = {}) {
      super();
      this.map = mapInstance;
      this.vehicle = vehicle;
      this.position = new googleMaps.LatLng(vehicle.lat, vehicle.lon);
      this.heading = normalizeHeading(vehicle.heading || 0);
      this.targetPosition = this.position;
      this.targetHeading = this.heading;
      this.animationStart = null;
      this.animationFrame = null;
      this.div = null;
      this.isAnimating = false;
      this.frameQueue = [];
      this.lagFrameCount = Math.max(0, options.lagFrameCount ?? 0);
      this.maxPendingFrames = Math.max(1, options.maxPendingFrames ?? MAX_PENDING_FRAMES);
      this.setMap(mapInstance);
    }

    onAdd() {
      const div = document.createElement("div");
      div.className = "vehicle-label";

      const text = document.createElement("div");
      text.className = "label-text";
      text.textContent = this.vehicle.id;

      div.appendChild(text);
      this.div = div;

      const panes = this.getPanes();
      panes.overlayLayer.appendChild(div);
      this.draw();
      this.maybeStartNextAnimation();
    }

    onRemove() {
      if (this.animationFrame) {
        cancelAnimationFrame(this.animationFrame);
      }
      this.animationFrame = null;
      this.animationStart = null;
      this.isAnimating = false;
      this.frameQueue = [];
      if (this.div?.parentNode) {
        this.div.parentNode.removeChild(this.div);
      }
      this.div = null;
    }

    draw() {
      if (!this.div) {
        return;
      }

      const overlayProjection = this.getProjection();
      if (!overlayProjection) {
        return;
      }

      const position = overlayProjection.fromLatLngToDivPixel(this.position);
      this.div.style.left = `${position.x}px`;
      this.div.style.top = `${position.y}px`;

      const mapInstance = this.getMap?.() || this.map;
      const zoom = mapInstance?.getZoom?.();
      const scale = getScaleForZoom(zoom);
      const rotation = this.heading - 90;
      this.div.style.transform = `translate(-50%, -50%) rotate(${rotation}deg) scale(${scale})`;
    }

    queueUpdate(vehicle, durationMs) {
      if (!Number.isFinite(vehicle.lat) || !Number.isFinite(vehicle.lon)) {
        return;
      }

      this.vehicle = vehicle;
      this.targetPosition = new googleMaps.LatLng(vehicle.lat, vehicle.lon);
      this.targetHeading = normalizeHeading(vehicle.heading || 0);

      const frame = {
        position: this.targetPosition,
        heading: this.targetHeading,
        duration: durationMs,
      };

      this.frameQueue.push(frame);

      const maxQueueLength = this.lagFrameCount + this.maxPendingFrames;
      if (this.frameQueue.length > maxQueueLength) {
        const dropCount = this.frameQueue.length - maxQueueLength;
        this.frameQueue.splice(0, dropCount);
      }

      if (!this.div) {
        return;
      }

      if (this.div.firstChild) {
        this.div.firstChild.textContent = vehicle.id;
      }

      this.maybeStartNextAnimation();
    }

    maybeStartNextAnimation() {
      if (this.isAnimating) {
        return;
      }

      if (this.frameQueue.length <= this.lagFrameCount) {
        return;
      }

      const nextFrame = this.frameQueue.shift();
      this.startAnimation(nextFrame);
    }

    startAnimation(frame) {
      if (!frame?.position) {
        return;
      }

      this.cancelAnimation();
      const startPosition = this.position;
      const startHeading = normalizeHeading(this.heading);
      const endHeading = normalizeHeading(frame.heading || 0);
      const headingDelta = shortestHeadingDelta(startHeading, endHeading);
      const animationDuration = Math.max(300, frame.duration || MIN_ANIMATION_DURATION_MS);

      this.targetPosition = frame.position;
      this.targetHeading = frame.heading || 0;
      this.isAnimating = true;
      this.animationStart = getTimestamp();

      if (
        startPosition.equals(this.targetPosition) &&
        Math.abs(headingDelta) < 0.001
      ) {
        this.isAnimating = false;
        this.animationStart = null;
        this.heading = normalizeHeading(endHeading);
        this.position = this.targetPosition;
        this.draw();
        this.maybeStartNextAnimation();
        return;
      }

      const step = (timestamp) => {
        if (!this.animationStart) {
          return;
        }

        const progress = Math.min(
          1,
          (timestamp - this.animationStart) / animationDuration
        );

        this.position = interpolateLatLng(
          startPosition,
          this.targetPosition,
          progress,
          googleMaps
        );
        this.heading = normalizeHeading(startHeading + headingDelta * progress);
        this.draw();

        if (progress < 1) {
          this.animationFrame = requestAnimationFrame(step);
        } else {
          this.animationStart = null;
          this.animationFrame = null;
          this.isAnimating = false;
          this.position = this.targetPosition;
          this.heading = normalizeHeading(endHeading);
          this.draw();
          this.maybeStartNextAnimation();
        }
      };

      this.animationFrame = requestAnimationFrame(step);
    }

    cancelAnimation() {
      if (this.animationFrame) {
        cancelAnimationFrame(this.animationFrame);
        this.animationFrame = null;
      }
      this.animationStart = null;
      this.isAnimating = false;
    }
  };
}

function createVehicleLayerClass(googleMaps) {
  const VehicleOverlay = createVehicleOverlayClass(googleMaps);

  return class VehicleLayer {
    constructor(mapInstance, vehicleIds = []) {
      this.map = mapInstance;
      this.vehicleIds = new Set(vehicleIds);
      this.fetcher = new VehicleFetcher();
      this.overlays = new Map();
      this.timerId = null;
      this.refreshPromise = null;
      this.pendingRefreshRequiresClear = false;
      this.onVehiclesUpdated = null;
      this.lastRefreshTimestamp = null;
      this.feedVehicleData = new Map();
    }

    async start() {
      this.stop();
      this.fetcher.reset();
      if (this.vehicleIds.size) {
        try {
          await this.refresh(true);
        } catch (error) {
          console.error("Vehicle refresh failed", error);
        }
      }
      this.scheduleNext();
    }

    stop() {
      if (this.timerId) {
        clearTimeout(this.timerId);
        this.timerId = null;
      }
      this.lastRefreshTimestamp = null;
    }

    clearOverlays() {
      for (const overlay of this.overlays.values()) {
        overlay.setMap(null);
      }
      this.overlays.clear();
    }

    async setVehicleIds(vehicleIds) {
      const uniqueIds = [...new Set(vehicleIds.filter((id) => id))];
      const nextIds = new Set(uniqueIds);
      const currentIds = new Set(this.vehicleIds);

      for (const id of currentIds) {
        if (!nextIds.has(id)) {
          this.removeVehicle(id);
        }
      }

      for (const id of uniqueIds) {
        if (!currentIds.has(id)) {
          await this.addVehicle(id);
        }
      }
    }

    async addVehicle(vehicleId) {
      if (!vehicleId) {
        return;
      }

      if (this.vehicleIds.has(vehicleId)) {
        this.emitVehicleStatus();
        return;
      }

      this.vehicleIds.add(vehicleId);

      let vehicle = this.feedVehicleData.get(vehicleId) || null;
      if (!vehicle) {
        try {
          vehicle = await this.fetcher.fetchVehicle(vehicleId);
        } catch (error) {
          console.error(`Vehicle fetch failed for ${vehicleId}`, error);
        }
        if (vehicle) {
          this.feedVehicleData.set(vehicle.id, vehicle);
        }
      }

      if (vehicle) {
        this.ensureOverlay(vehicle, MIN_ANIMATION_DURATION_MS);
      }

      this.emitVehicleStatus(vehicle ? new Set([vehicleId]) : new Set());

      if (!this.timerId) {
        this.scheduleNext();
      }

      if (!this.refreshPromise) {
        this.refresh().catch((error) => {
          console.error("Vehicle refresh failed", error);
        });
      }
    }

    removeVehicle(vehicleId) {
      if (!this.vehicleIds.delete(vehicleId)) {
        return;
      }

      const overlay = this.overlays.get(vehicleId);
      if (overlay) {
        overlay.setMap(null);
        this.overlays.delete(vehicleId);
      }

      this.emitVehicleStatus();

      if (!this.vehicleIds.size) {
        this.stop();
      }
    }

    async refresh(clearOverlays = false) {
      if (this.refreshPromise) {
        if (clearOverlays) {
          this.pendingRefreshRequiresClear = true;
        }
        return this.refreshPromise;
      }

      if (clearOverlays) {
        this.clearOverlays();
      }

      if (!this.vehicleIds.size) {
        this.emitVehicleStatus();
        return;
      }

      const executeRefresh = async () => {
        const now = getTimestamp();
        const elapsed = this.lastRefreshTimestamp
          ? now - this.lastRefreshTimestamp
          : REFRESH_INTERVAL_MS;
        const baseDuration = clamp(
          elapsed,
          MIN_ANIMATION_DURATION_MS,
          MAX_ANIMATION_DURATION_MS
        );
        this.lastRefreshTimestamp = now;

        const { vehicles: updates } = await this.fetcher.fetchUpdates();
        const updatedIds = new Set();

        for (const vehicle of updates) {
          if (
            !vehicle ||
            !Number.isFinite(vehicle.lat) ||
            !Number.isFinite(vehicle.lon)
          ) {
            continue;
          }

          this.feedVehicleData.set(vehicle.id, vehicle);

          if (!this.vehicleIds.has(vehicle.id)) {
            continue;
          }

          updatedIds.add(vehicle.id);

          const secsSinceReport =
            Number.isFinite(vehicle.secsSinceReport) &&
            vehicle.secsSinceReport >= 0
              ? vehicle.secsSinceReport
              : null;
          const reportedAgoMs =
            secsSinceReport !== null
              ? vehicle.secsSinceReport * 1000
              : baseDuration;
          const frameDuration = clamp(
            Math.max(baseDuration, reportedAgoMs),
            MIN_ANIMATION_DURATION_MS,
            MAX_ANIMATION_DURATION_MS
          );
          this.ensureOverlay(vehicle, frameDuration);
        }

        for (const [key, overlay] of this.overlays.entries()) {
          if (!this.vehicleIds.has(key)) {
            overlay.setMap(null);
            this.overlays.delete(key);
          }
        }

        this.emitVehicleStatus(updatedIds);
      };

      this.refreshPromise = executeRefresh();
      try {
        await this.refreshPromise;
      } finally {
        this.refreshPromise = null;
        if (this.pendingRefreshRequiresClear) {
          this.pendingRefreshRequiresClear = false;
          await this.refresh(true);
        }
      }
    }

    scheduleNext() {
      if (this.timerId) {
        clearTimeout(this.timerId);
      }

      if (!this.vehicleIds.size) {
        return;
      }

      this.timerId = setTimeout(async () => {
        this.timerId = null;
        try {
          await this.refresh();
        } catch (error) {
          console.error("Vehicle refresh failed", error);
        }
        this.scheduleNext();
      }, REFRESH_INTERVAL_MS);
    }

    ensureOverlay(vehicle, frameDuration) {
      if (!vehicle?.id) {
        return;
      }

      const key = vehicle.id;
      if (this.overlays.has(key)) {
        this.overlays.get(key).queueUpdate(vehicle, frameDuration);
        return;
      }

      const overlay = new VehicleOverlay(this.map, vehicle, {
        lagFrameCount: FRAME_LAG_COUNT,
        maxPendingFrames: MAX_PENDING_FRAMES,
      });
      this.overlays.set(key, overlay);
      overlay.queueUpdate(vehicle, frameDuration);
    }

    emitVehicleStatus(updatedIds = new Set()) {
      if (typeof this.onVehiclesUpdated !== "function") {
        return;
      }

      const vehicles = new Map();
      for (const vehicleId of this.vehicleIds) {
        vehicles.set(vehicleId, this.feedVehicleData.get(vehicleId) || null);
      }

      this.onVehiclesUpdated({
        vehicles,
        updatedVehicleIds: new Set(updatedIds),
      });
    }
  };
}

function createControlPanelClass() {
  return class ControlPanel {
    constructor(vehicleLayer, mapInstance = null) {
      this.vehicleLayer = vehicleLayer;
      this.map = mapInstance;
      this.form = document.getElementById("vehicle-form");
      this.input = document.getElementById("vehicle-input");
      this.list = document.getElementById("tracked-vehicles");
      this.emptyState = document.getElementById("vehicle-empty-state");
      this.vehicleItems = new Map();
      this.vehicleOrder = [];
      this.mapStyleSelect = document.getElementById("map-style-select");

      this.vehicleLayer.onVehiclesUpdated = (snapshot) => {
        this.updateVehicleStatuses(snapshot);
      };

      this.attachEvents();
      this.syncMapStyleSelect();
      this.updateEmptyState();
    }

    attachEvents() {
      this.form?.addEventListener("submit", async (event) => {
        event.preventDefault();
        await this.handleFormSubmit();
      });

      this.input?.addEventListener("input", () => {
        this.input.setCustomValidity("");
      });

      this.mapStyleSelect?.addEventListener("change", () => {
        this.handleMapStyleChange();
      });
    }

    async handleFormSubmit() {
      if (!this.input) {
        return;
      }
      const vehicleId = this.normalizeVehicleId(this.input.value);
      if (!vehicleId) {
        this.input.setCustomValidity("Enter a four-digit vehicle number.");
        this.input.reportValidity();
        return;
      }

      if (this.vehicleItems.has(vehicleId)) {
        this.flashVehicle(vehicleId);
        this.input.value = "";
        return;
      }

      this.input.value = "";
      await this.addVehicle(vehicleId);
    }

    normalizeVehicleId(value) {
      if (typeof value !== "string") {
        return null;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const digitsOnly = trimmed.replace(/[^0-9]/g, "");
      if (digitsOnly.length !== 4) {
        return null;
      }
      return digitsOnly;
    }

    async addVehicle(vehicleId) {
      this.vehicleOrder.push(vehicleId);
      const item = this.createVehicleItem(vehicleId);
      this.vehicleItems.set(vehicleId, item);
      this.list?.appendChild(item.element);
      this.updateEmptyState();
      await this.vehicleLayer.addVehicle(vehicleId);
      this.input?.focus();
    }

    removeVehicle(vehicleId) {
      this.vehicleOrder = this.vehicleOrder.filter((id) => id !== vehicleId);
      const item = this.vehicleItems.get(vehicleId);
      if (item?.element?.parentNode) {
        item.element.parentNode.removeChild(item.element);
      }
      this.vehicleItems.delete(vehicleId);
      this.updateEmptyState();
      this.vehicleLayer.removeVehicle(vehicleId);
    }

    flashVehicle(vehicleId) {
      const item = this.vehicleItems.get(vehicleId);
      if (!item?.element) {
        return;
      }
      item.element.classList.remove("vehicle-pill--highlight");
      void item.element.offsetWidth;
      item.element.classList.add("vehicle-pill--highlight");
    }

    createVehicleItem(vehicleId) {
      const wrapper = document.createElement("div");
      wrapper.className = "vehicle-pill";
      wrapper.setAttribute("role", "listitem");
      wrapper.dataset.vehicleId = vehicleId;

      const header = document.createElement("div");
      header.className = "vehicle-pill__header";

      const label = document.createElement("span");
      label.className = "vehicle-pill__id";
      label.textContent = vehicleId;

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "icon-button";
      removeButton.setAttribute(
        "aria-label",
        `Stop tracking vehicle ${vehicleId}`
      );
      removeButton.textContent = "✕";
      removeButton.addEventListener("click", () => {
        this.removeVehicle(vehicleId);
      });

      header.appendChild(label);
      header.appendChild(removeButton);

      const status = document.createElement("div");
      status.className = "vehicle-pill__status";
      status.textContent = "Waiting for location…";

      wrapper.appendChild(header);
      wrapper.appendChild(status);

      return { element: wrapper, status };
    }

    updateVehicleStatuses(snapshot) {
      const vehicles = snapshot?.vehicles instanceof Map ? snapshot.vehicles : new Map();
      const updatedVehicleIds = snapshot?.updatedVehicleIds instanceof Set
        ? snapshot.updatedVehicleIds
        : new Set(snapshot?.updatedVehicleIds || []);

      for (const vehicleId of this.vehicleOrder) {
        const item = this.vehicleItems.get(vehicleId);
        if (!item) {
          continue;
        }

        const vehicle = vehicles.get(vehicleId) || null;

        if (!vehicle) {
          item.status.textContent = "Waiting for location…";
          continue;
        }

        const parts = [];
        if (vehicle.routeTag) {
          parts.push(`Route ${vehicle.routeTag}`);
        }

        if (Number.isFinite(vehicle.secsSinceReport)) {
          if (vehicle.secsSinceReport <= 5) {
            parts.push("Just now");
          } else {
            parts.push(`${vehicle.secsSinceReport}s ago`);
          }
        }

        if (!updatedVehicleIds.has(vehicleId)) {
          parts.push("No movement since last update");
        }

        item.status.textContent = parts.length
          ? parts.join(" • ")
          : "Location received";
      }
    }

    updateEmptyState() {
      const hasVehicles = this.vehicleOrder.length > 0;
      if (this.emptyState) {
        this.emptyState.style.display = hasVehicles ? "none" : "block";
      }
      if (this.list) {
        this.list.style.display = hasVehicles ? "grid" : "none";
      }
    }

    syncMapStyleSelect() {
      if (!this.mapStyleSelect || !this.map?.getMapTypeId) {
        return;
      }

      const currentType = this.map.getMapTypeId();
      this.mapStyleSelect.value =
        typeof currentType === "string" && currentType ? currentType : "roadmap";
    }

    handleMapStyleChange() {
      if (!this.mapStyleSelect) {
        return;
      }

      const mapType = this.mapStyleSelect.value || "roadmap";
      if (!this.map) {
        return;
      }

      this.map.setMapTypeId(mapType);
      this.map.setOptions({
        styles: mapType === "roadmap" ? ROADMAP_STYLES : null,
      });
      enforceTopDownView(this.map);
    }
  };
}

function enforceTopDownView(mapInstance) {
  if (!mapInstance) {
    return;
  }

  if (typeof mapInstance.getTilt === "function") {
    const tilt = mapInstance.getTilt();
    if (tilt !== 0 && typeof mapInstance.setTilt === "function") {
      mapInstance.setTilt(0);
    }
  }

  if (typeof mapInstance.getHeading === "function") {
    const heading = mapInstance.getHeading();
    if (heading !== 0 && typeof mapInstance.setHeading === "function") {
      mapInstance.setHeading(0);
    }
  }
}

function installTopDownViewEnforcement(mapInstance, googleMaps) {
  if (!mapInstance || !googleMaps?.event) {
    return;
  }

  const enforce = () => enforceTopDownView(mapInstance);
  enforce();

  const events = [
    "maptypeid_changed",
    "tilt_changed",
    "heading_changed",
    "zoom_changed",
  ];

  for (const eventName of events) {
    googleMaps.event.addListener(mapInstance, eventName, enforce);
  }
}

function getMapStatusElement() {
  return document.getElementById(MAP_STATUS_ID);
}

function updateMapStatus(message, isError = false) {
  const statusElement = getMapStatusElement();
  if (!statusElement) {
    return;
  }

  statusElement.textContent = message;
  statusElement.dataset.state = isError ? "error" : "info";
  statusElement.style.display = "block";
}

function clearMapStatus() {
  const statusElement = getMapStatusElement();
  if (!statusElement) {
    return;
  }

  statusElement.remove();
}

async function fetchGoogleMapsApiKey() {
  const fallbackKey =
    window.GOOGLE_MAPS_API_KEY ||
    document
      .querySelector('meta[name="google-maps-api-key"]')
      ?.getAttribute("content");

  try {
    const response = await fetch("/.netlify/functions/google-maps-key");
    if (!response.ok) {
      throw new Error("Unable to load Google Maps API key");
    }

    const data = await response.json().catch(() => ({}));
    if (data && data.googleMapsApiKey) {
      return data.googleMapsApiKey;
    }
  } catch (error) {
    if (fallbackKey) {
      return fallbackKey;
    }
    throw error;
  }

  if (fallbackKey) {
    return fallbackKey;
  }

  throw new Error("Google Maps API key is not configured");
}

function loadGoogleMapsScript(apiKey) {
  return new Promise((resolve, reject) => {
    if (window.google?.maps) {
      resolve();
      return;
    }

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      apiKey
    )}`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Maps script"));
    document.head.appendChild(script);
  });
}

async function initializeApp() {
  updateMapStatus("Loading map…");
  try {
    const apiKey = await fetchGoogleMapsApiKey();
    await loadGoogleMapsScript(apiKey);
    initMap();
  } catch (error) {
    console.error("Failed to initialize Google Maps", error);
    updateMapStatus(
      "Unable to load Google Maps. Check configuration and try again.",
      true
    );
  }
}

function initMap() {
  const googleMaps = window.google?.maps;
  if (!googleMaps) {
    throw new Error("Google Maps library is unavailable");
  }

  const VehicleLayer = createVehicleLayerClass(googleMaps);
  const ControlPanel = createControlPanelClass();

  map = new googleMaps.Map(document.getElementById("map"), {
    center: { lat: 43.6532, lng: -79.3832 },
    zoom: 12,
    disableDefaultUI: true,
    styles: ROADMAP_STYLES,
  });

  installTopDownViewEnforcement(map, googleMaps);

  clearMapStatus();

  const vehicleLayer = new VehicleLayer(map);
  new ControlPanel(vehicleLayer, map);
  vehicleLayer.start();
}

initializeApp();

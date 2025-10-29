const REFRESH_INTERVAL_MS = 5000;
const FRAME_LAG_COUNT = 1;
const MAX_PENDING_FRAMES = 3;
const MIN_ANIMATION_DURATION_MS = REFRESH_INTERVAL_MS;
const MAX_ANIMATION_DURATION_MS = REFRESH_INTERVAL_MS * 3;
const API_BASE_URL = "https://retro.umoiq.com/service/publicXMLFeed";
const AGENCY_TAG = "ttc";
const MAP_STATUS_ID = "map-status";

let map;

class VehicleFetcher {
  constructor(vehicleIds = []) {
    this.vehicleIds = [...vehicleIds];
  }

  setVehicleIds(vehicleIds) {
    this.vehicleIds = [...vehicleIds];
  }

  async fetchAll() {
    if (!this.vehicleIds.length) {
      return [];
    }

    const requests = this.vehicleIds.map((vehicleId) =>
      this.fetchVehicle(vehicleId).catch((error) => {
        console.error(`Vehicle fetch failed for ${vehicleId}`, error);
        return null;
      })
    );

    const vehicles = await Promise.all(requests);
    return vehicles.filter((vehicle) => Boolean(vehicle));
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

      const rotation = this.heading - 90;
      this.div.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
    }

    queueUpdate(vehicle, durationMs) {
      if (!Number.isFinite(vehicle.lat) || !Number.isFinite(vehicle.lon)) {
        return;
      }

      this.vehicle = vehicle;
      this.targetPosition = new googleMaps.LatLng(vehicle.lat, vehicle.lon);
      this.targetHeading = vehicle.heading || 0;

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
      this.fetcher = new VehicleFetcher([...this.vehicleIds]);
      this.overlays = new Map();
      this.timerId = null;
      this.refreshPromise = null;
      this.pendingRefreshRequiresClear = false;
      this.onVehiclesUpdated = null;
      this.lastRefreshTimestamp = null;
    }

    async start() {
      this.stop();
      try {
        await this.refresh();
      } catch (error) {
        console.error("Vehicle refresh failed", error);
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
      this.vehicleIds = new Set(uniqueIds);
      this.fetcher.setVehicleIds(uniqueIds);
      this.stop();
      this.lastRefreshTimestamp = null;
      try {
        await this.refresh(true);
      } catch (error) {
        console.error("Vehicle refresh failed", error);
      }
      this.scheduleNext();
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

      const executeRefresh = async () => {
        if (!this.vehicleIds.size) {
          this.onVehiclesUpdated?.([]);
          this.clearOverlays();
          this.lastRefreshTimestamp = null;
          return;
        }

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

        const vehicles = await this.fetcher.fetchAll();
        const activeVehicles = vehicles.filter((vehicle) =>
          this.vehicleIds.has(vehicle.id)
        );
        this.onVehiclesUpdated?.(activeVehicles);

        const seenIds = new Set();
        for (const vehicle of activeVehicles) {
          if (
            !Number.isFinite(vehicle.lat) ||
            !Number.isFinite(vehicle.lon)
          ) {
            continue;
          }
          const key = vehicle.id;
          seenIds.add(key);
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
          if (this.overlays.has(key)) {
            const overlay = this.overlays.get(key);
            overlay.queueUpdate(vehicle, frameDuration);
          } else {
            const overlay = new VehicleOverlay(this.map, vehicle, {
              lagFrameCount: FRAME_LAG_COUNT,
              maxPendingFrames: MAX_PENDING_FRAMES,
            });
            this.overlays.set(key, overlay);
            overlay.queueUpdate(vehicle, frameDuration);
          }
        }

        for (const [key, overlay] of this.overlays.entries()) {
          if (!seenIds.has(key)) {
            overlay.setMap(null);
            this.overlays.delete(key);
          }
        }
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
  };
}

function createControlPanelClass() {
  return class ControlPanel {
    constructor(vehicleLayer) {
      this.vehicleLayer = vehicleLayer;
      this.form = document.getElementById("vehicle-form");
      this.input = document.getElementById("vehicle-input");
      this.list = document.getElementById("tracked-vehicles");
      this.emptyState = document.getElementById("vehicle-empty-state");
      this.vehicleItems = new Map();
      this.vehicleOrder = [];

      this.vehicleLayer.onVehiclesUpdated = (vehicles) => {
        this.updateVehicleStatuses(vehicles);
      };

      this.attachEvents();
      this.updateEmptyState();
    }

    attachEvents() {
      this.form?.addEventListener("submit", (event) => {
        event.preventDefault();
        this.handleFormSubmit();
      });

      this.input?.addEventListener("input", () => {
        this.input.setCustomValidity("");
      });
    }

    handleFormSubmit() {
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
      this.addVehicle(vehicleId);
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

    addVehicle(vehicleId) {
      this.vehicleOrder.push(vehicleId);
      const item = this.createVehicleItem(vehicleId);
      this.vehicleItems.set(vehicleId, item);
      this.list?.appendChild(item.element);
      this.updateEmptyState();
      this.vehicleLayer.setVehicleIds([...this.vehicleOrder]);
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
      this.vehicleLayer.setVehicleIds([...this.vehicleOrder]);
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
      status.textContent = "Waiting for updates…";

      wrapper.appendChild(header);
      wrapper.appendChild(status);

      return { element: wrapper, status };
    }

    updateVehicleStatuses(vehicles) {
      const vehicleMap = new Map((vehicles || []).map((vehicle) => [vehicle.id, vehicle]));
      for (const vehicleId of this.vehicleOrder) {
        const item = this.vehicleItems.get(vehicleId);
        if (!item) {
          continue;
        }
        const vehicle = vehicleMap.get(vehicleId);
        if (vehicle) {
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
          item.status.textContent = parts.length
            ? parts.join(" • ")
            : "Receiving updates";
        } else {
          item.status.textContent = "No recent data";
        }
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
  };
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
    styles: [
      {
        featureType: "poi",
        stylers: [{ visibility: "off" }],
      },
    ],
  });

  clearMapStatus();

  const vehicleLayer = new VehicleLayer(map);
  new ControlPanel(vehicleLayer);
  vehicleLayer.start();
}

initializeApp();

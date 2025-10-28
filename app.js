const REFRESH_INTERVAL_MS = 5000;
const ANIMATION_DURATION_MS = 1200;
const API_BASE_URL = "https://retro.umoiq.com/service/publicXMLFeed";
const AGENCY_TAG = "ttc";
const DEFAULT_ROUTE_SELECTION = ["29", "501", "504", "510"];

let map;

class VehicleFetcher {
  constructor(routes = []) {
    this.routes = routes;
  }

  setRoutes(routes) {
    this.routes = routes;
  }

  async fetchAll() {
    if (!this.routes.length) {
      return [];
    }

    const requests = this.routes.map((route) =>
      this.fetchRouteVehicles(route).catch((error) => {
        console.error(`Vehicle fetch failed for route ${route}`, error);
        return [];
      })
    );

    const routeVehicles = await Promise.all(requests);
    return routeVehicles.flat();
  }

  async fetchRouteVehicles(route) {
    const url = new URL(API_BASE_URL);
    url.searchParams.set("command", "vehicleLocations");
    url.searchParams.set("a", AGENCY_TAG);
    url.searchParams.set("r", route);
    url.searchParams.set("t", "0");

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Failed to fetch vehicles for route ${route}`);
    }

    const text = await response.text();
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, "text/xml");
    const vehicleNodes = [...xml.querySelectorAll("vehicle")];

    return vehicleNodes.map((node) => ({
      id: node.getAttribute("id"),
      routeTag: node.getAttribute("routeTag"),
      heading: parseFloat(node.getAttribute("heading") || "0"),
      lat: parseFloat(node.getAttribute("lat")),
      lon: parseFloat(node.getAttribute("lon")),
      predictable: node.getAttribute("predictable") !== "false",
      secsSinceReport: parseInt(node.getAttribute("secsSinceReport") || "0", 10),
      speedKmHr: parseFloat(node.getAttribute("speedKmHr") || "0"),
    }));
  }
}

class VehicleOverlay extends google.maps.OverlayView {
  constructor(mapInstance, vehicle) {
    super();
    this.map = mapInstance;
    this.vehicle = vehicle;
    this.position = new google.maps.LatLng(vehicle.lat, vehicle.lon);
    this.heading = vehicle.heading || 0;
    this.targetPosition = this.position;
    this.targetHeading = this.heading;
    this.animationStart = null;
    this.animationFrame = null;
    this.div = null;
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
  }

  onRemove() {
    if (this.div?.parentNode) {
      cancelAnimationFrame(this.animationFrame);
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

    this.div.style.transform = `translate(-50%, -50%) rotate(${this.heading}deg)`;
  }

  update(vehicle) {
    this.vehicle = vehicle;
    this.targetPosition = new google.maps.LatLng(vehicle.lat, vehicle.lon);
    this.targetHeading = vehicle.heading || 0;
    if (!this.div) {
      return;
    }

    if (this.div.firstChild) {
      this.div.firstChild.textContent = vehicle.id;
    }

    this.startAnimation();
  }

  startAnimation() {
    this.cancelAnimation();
    const startPosition = this.position;
    const startHeading = normalizeHeading(this.heading);
    const endHeading = normalizeHeading(this.targetHeading);
    const headingDelta = shortestHeadingDelta(startHeading, endHeading);

    this.animationStart = performance.now();

    const step = (timestamp) => {
      if (!this.animationStart) {
        return;
      }

      const progress = Math.min(
        1,
        (timestamp - this.animationStart) / ANIMATION_DURATION_MS
      );

      this.position = interpolateLatLng(startPosition, this.targetPosition, progress);
      this.heading = normalizeHeading(startHeading + headingDelta * progress);
      this.draw();

      if (progress < 1) {
        this.animationFrame = requestAnimationFrame(step);
      } else {
        this.animationStart = null;
        this.position = this.targetPosition;
        this.heading = normalizeHeading(endHeading);
        this.draw();
      }
    };

    this.animationFrame = requestAnimationFrame(step);
  }

  cancelAnimation() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }
}

class VehicleLayer {
  constructor(mapInstance, routes = []) {
    this.map = mapInstance;
    this.routes = [...routes];
    this.fetcher = new VehicleFetcher(this.routes);
    this.overlays = new Map();
    this.timerId = null;
    this.vehicleFilter = new Set();
    this.refreshPromise = null;
    this.pendingRefreshRequiresClear = false;
    this.onVehiclesUpdated = null;
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
  }

  clearOverlays() {
    for (const overlay of this.overlays.values()) {
      overlay.setMap(null);
    }
    this.overlays.clear();
  }

  async setRoutes(routes) {
    const uniqueRoutes = [...new Set(routes)];
    this.routes = uniqueRoutes;
    this.fetcher.setRoutes(uniqueRoutes);
    this.vehicleFilter.clear();
    this.stop();
    try {
      await this.refresh(true);
    } catch (error) {
      console.error("Vehicle refresh failed", error);
    }
    this.scheduleNext();
  }

  async setVehicleFilter(vehicleIds) {
    this.vehicleFilter = new Set(vehicleIds);
    this.stop();
    try {
      await this.refresh();
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
      if (!this.routes.length) {
        this.onVehiclesUpdated?.([]);
        return;
      }

      const vehicles = await this.fetcher.fetchAll();
      this.onVehiclesUpdated?.(vehicles);
      const filteredVehicles = this.vehicleFilter.size
        ? vehicles.filter((vehicle) => this.vehicleFilter.has(vehicle.id))
        : vehicles;

      const seenIds = new Set();
      filteredVehicles.forEach((vehicle) => {
        seenIds.add(vehicle.id);
        const overlay = this.overlays.get(vehicle.id);
        if (overlay) {
          overlay.update(vehicle);
        } else {
          const newOverlay = new VehicleOverlay(this.map, vehicle);
          this.overlays.set(vehicle.id, newOverlay);
        }
      });

      for (const [id, overlay] of this.overlays.entries()) {
        if (!seenIds.has(id)) {
          overlay.setMap(null);
          this.overlays.delete(id);
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

    if (!this.routes.length) {
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
}

class ControlPanel {
  constructor(vehicleLayer) {
    this.vehicleLayer = vehicleLayer;
    this.routeContainer = document.getElementById("route-options");
    this.vehicleContainer = document.getElementById("vehicle-options");
    this.selectAllRoutesButton = document.getElementById("select-all-routes");
    this.clearVehicleFilterButton = document.getElementById("clear-vehicle-filter");
    this.routeMeta = new Map();
    this.routeOptionElements = new Map();
    this.vehicleOptionElements = new Map();
    this.selectedRoutes = new Set();
    this.selectedVehicleIds = new Set();

    this.vehicleLayer.onVehiclesUpdated = (vehicles) => {
      this.updateVehicleList(vehicles);
    };

    this.wireEvents();
    this.init();
  }

  wireEvents() {
    this.selectAllRoutesButton?.addEventListener("click", () => {
      this.selectAllRoutes();
    });

    this.clearVehicleFilterButton?.addEventListener("click", () => {
      this.clearVehicleFilter();
    });
  }

  async init() {
    this.showRouteLoadingState();
    try {
      const routes = await fetchRouteList();
      routes.forEach((route) => this.routeMeta.set(route.tag, route));
      this.renderRouteOptions(routes);
      this.applyDefaultRoutes(routes);
    } catch (error) {
      console.error("Failed to load routes", error);
      this.showRouteErrorState();
    }
  }

  showRouteLoadingState() {
    this.routeContainer.innerHTML = "";
    const message = document.createElement("div");
    message.className = "empty-state";
    message.textContent = "Loading routes…";
    this.routeContainer.appendChild(message);
  }

  showRouteErrorState() {
    this.routeContainer.innerHTML = "";
    const message = document.createElement("div");
    message.className = "empty-state";
    message.textContent = "Unable to load routes. Try again later.";
    this.routeContainer.appendChild(message);
  }

  renderRouteOptions(routes) {
    this.routeContainer.innerHTML = "";
    this.routeOptionElements.clear();
    if (!routes.length) {
      const message = document.createElement("div");
      message.className = "empty-state";
      message.textContent = "No routes available.";
      this.routeContainer.appendChild(message);
      return;
    }

    routes.forEach((route) => {
      const chip = this.createOptionChip({
        id: route.tag,
        label: `${route.title} (${route.tag})`,
        checked: this.selectedRoutes.has(route.tag),
        onChange: (checked) => this.handleRouteToggle(route.tag, checked),
      });
      this.routeOptionElements.set(route.tag, chip);
      this.routeContainer.appendChild(chip);
    });
  }

  applyDefaultRoutes(routes) {
    const availableTags = routes.map((route) => route.tag);
    const defaults = DEFAULT_ROUTE_SELECTION.filter((tag) =>
      availableTags.includes(tag)
    );

    const initialSelection = defaults.length
      ? defaults
      : availableTags.slice(0, Math.min(4, availableTags.length));

    this.selectedRoutes = new Set(initialSelection);
    this.syncRouteSelections();
    this.vehicleLayer.setRoutes(initialSelection);
  }

  selectAllRoutes() {
    const allRouteTags = [...this.routeMeta.keys()];
    if (!allRouteTags.length) {
      return;
    }
    this.selectedRoutes = new Set(allRouteTags);
    this.syncRouteSelections();
    this.selectedVehicleIds.clear();
    this.vehicleOptionElements.clear();
    this.vehicleContainer.innerHTML = "";
    const loadingMessage = document.createElement("div");
    loadingMessage.className = "empty-state";
    loadingMessage.textContent = "Loading vehicles…";
    this.vehicleContainer.appendChild(loadingMessage);
    this.vehicleLayer.setRoutes(allRouteTags);
  }

  clearVehicleFilter() {
    if (!this.selectedVehicleIds.size) {
      return;
    }
    this.selectedVehicleIds.clear();
    this.vehicleOptionElements.forEach((chip) => {
      chip.dataset.checked = "false";
      const input = chip.querySelector("input");
      if (input) {
        input.checked = false;
      }
    });
    this.vehicleLayer.setVehicleFilter([]);
  }

  handleRouteToggle(routeTag, isChecked) {
    if (isChecked) {
      this.selectedRoutes.add(routeTag);
    } else {
      this.selectedRoutes.delete(routeTag);
    }

    this.syncRouteSelections();
    this.selectedVehicleIds.clear();
    this.vehicleOptionElements.clear();
    this.vehicleContainer.innerHTML = "";

    if (!this.selectedRoutes.size) {
      const message = document.createElement("div");
      message.className = "empty-state";
      message.textContent = "Choose at least one route to begin tracking.";
      this.vehicleContainer.appendChild(message);
    } else {
      const loadingMessage = document.createElement("div");
      loadingMessage.className = "empty-state";
      loadingMessage.textContent = "Loading vehicles…";
      this.vehicleContainer.appendChild(loadingMessage);
    }

    const currentRoutes = [...this.selectedRoutes];
    if (currentRoutes.length) {
      this.vehicleLayer.setRoutes(currentRoutes);
    } else {
      this.vehicleLayer.setRoutes([]);
    }
  }

  updateVehicleList(vehicles) {
    this.vehicleContainer.innerHTML = "";
    this.vehicleOptionElements.clear();

    if (!vehicles.length) {
      const message = document.createElement("div");
      message.className = "empty-state";
      message.textContent = this.selectedRoutes.size
        ? "Vehicles will appear as the feed updates."
        : "Choose at least one route to begin tracking.";
      this.vehicleContainer.appendChild(message);
      this.selectedVehicleIds.clear();
      return;
    }

    const availableIds = new Set(vehicles.map((vehicle) => vehicle.id));
    let selectionChanged = false;
    for (const id of [...this.selectedVehicleIds]) {
      if (!availableIds.has(id)) {
        this.selectedVehicleIds.delete(id);
        selectionChanged = true;
      }
    }

    const sortedVehicles = [...vehicles].sort((a, b) => {
      if (a.routeTag === b.routeTag) {
        return a.id.localeCompare(b.id, undefined, { numeric: true });
      }
      return a.routeTag.localeCompare(b.routeTag, undefined, { numeric: true });
    });

    sortedVehicles.forEach((vehicle) => {
      const routeTitle = this.routeMeta.get(vehicle.routeTag)?.title || vehicle.routeTag;
      const chip = this.createOptionChip({
        id: vehicle.id,
        label: `${vehicle.id} · ${routeTitle}`,
        checked: this.selectedVehicleIds.has(vehicle.id),
        onChange: (checked) => this.handleVehicleToggle(vehicle.id, checked),
      });
      this.vehicleOptionElements.set(vehicle.id, chip);
      this.vehicleContainer.appendChild(chip);
    });

    if (selectionChanged) {
      this.vehicleLayer.setVehicleFilter([...this.selectedVehicleIds]);
    }
  }

  handleVehicleToggle(vehicleId, isChecked) {
    if (isChecked) {
      this.selectedVehicleIds.add(vehicleId);
    } else {
      this.selectedVehicleIds.delete(vehicleId);
    }

    const chip = this.vehicleOptionElements.get(vehicleId);
    if (chip) {
      chip.dataset.checked = isChecked ? "true" : "false";
      const input = chip.querySelector("input");
      if (input) {
        input.checked = isChecked;
      }
    }

    this.vehicleLayer.setVehicleFilter([...this.selectedVehicleIds]);
  }

  syncRouteSelections() {
    this.routeOptionElements.forEach((chip, routeTag) => {
      const isChecked = this.selectedRoutes.has(routeTag);
      chip.dataset.checked = isChecked ? "true" : "false";
      const input = chip.querySelector("input");
      if (input) {
        input.checked = isChecked;
      }
    });
  }

  createOptionChip({ id, label, checked, onChange }) {
    const chip = document.createElement("label");
    chip.className = "option-chip";
    chip.dataset.checked = checked ? "true" : "false";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(checked);
    input.setAttribute("data-id", id);

    input.addEventListener("change", (event) => {
      const isChecked = event.target.checked;
      chip.dataset.checked = isChecked ? "true" : "false";
      onChange?.(isChecked);
    });

    const text = document.createElement("span");
    text.textContent = label;

    chip.appendChild(input);
    chip.appendChild(text);
    return chip;
  }
}

function interpolateLatLng(start, end, fraction) {
  const lat = start.lat() + (end.lat() - start.lat()) * fraction;
  const lng = start.lng() + (end.lng() - start.lng()) * fraction;
  return new google.maps.LatLng(lat, lng);
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

async function fetchRouteList() {
  const url = new URL(API_BASE_URL);
  url.searchParams.set("command", "routeList");
  url.searchParams.set("a", AGENCY_TAG);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error("Unable to fetch route list");
  }

  const text = await response.text();
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, "text/xml");
  const routeNodes = [...xml.querySelectorAll("route")];

  return routeNodes
    .map((node) => ({
      tag: node.getAttribute("tag"),
      title: node.getAttribute("title") || node.getAttribute("tag"),
    }))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
}

function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
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

  const vehicleLayer = new VehicleLayer(map);
  new ControlPanel(vehicleLayer);
  vehicleLayer.start();
}

window.initMap = initMap;

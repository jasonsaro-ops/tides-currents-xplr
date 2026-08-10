/**
 * TIDES & CURRENTS XPLR — FlexLayout-style docking via Golden Layout
 * Drag tabs to dock/stack/split. JSON serialize workspace.
 */
(function (global) {
  const STORAGE_KEY = "tcx_gl_layout_v1";
  const COMPONENT_IDS = [
    "map", "filters", "legend", "basemap", "warnings", "nowcoast",
    "active", "states", "sources", "hydro", "watch"
  ];

  let layout = null;

  function defaultConfig() {
    return {
      settings: {
        hasHeaders: true,
        constrainDragToContainer: false,
        reorderEnabled: true,
        selectionEnabled: false,
        popoutWholeStack: false,
        blockedPopoutsThrowError: true,
        closePopoutsOnUnload: true,
        showPopoutIcon: true,
        showMaximiseIcon: true,
        showCloseIcon: true,
        responsiveMode: "onload"
      },
      dimensions: {
        borderWidth: 4,
        minItemHeight: 80,
        minItemWidth: 140,
        headerHeight: 26,
        dragProxyWidth: 280,
        dragProxyHeight: 180
      },
      labels: {
        close: "close",
        maximise: "maximise",
        minimise: "minimise",
        popout: "pop out"
      },
      content: [
        {
          type: "column",
          content: [
            {
              type: "row",
              height: 72,
              content: [
                {
                  type: "stack",
                  width: 18,
                  content: [
                    { type: "component", componentName: "filters", title: "FILTERS", isClosable: true },
                    { type: "component", componentName: "legend", title: "LEGEND", isClosable: true },
                    { type: "component", componentName: "basemap", title: "BASEMAP", isClosable: true },
                    { type: "component", componentName: "warnings", title: "ALERTS", isClosable: true },
                    { type: "component", componentName: "nowcoast", title: "nowCOAST", isClosable: true }
                  ]
                },
                {
                  type: "component",
                  componentName: "map",
                  title: "MAP // TIDES & CURRENTS",
                  isClosable: false,
                  width: 62
                },
                {
                  type: "stack",
                  width: 20,
                  content: [
                    { type: "component", componentName: "active", title: "REALTIME", isClosable: true },
                    { type: "component", componentName: "states", title: "STATES", isClosable: true },
                    { type: "component", componentName: "hydro", title: "HYDROLOGY", isClosable: true },
                    { type: "component", componentName: "sources", title: "SOURCES", isClosable: true }
                  ]
                }
              ]
            },
            {
              type: "component",
              componentName: "watch",
              title: "WATCH // REALTIME",
              height: 28,
              isClosable: false
            }
          ]
        }
      ]
    };
  }

  function mountPanel(container, id) {
    const $el = container.getElement();
    $el.addClass("gl-component-host");
    const body = document.getElementById("panel-" + id);
    if (body) {
      // Move live DOM so all event bindings / IDs stay valid
      $el.empty().append(body);
      body.style.display = "block";
      body.style.height = "100%";
      body.style.overflow = "auto";
    } else {
      $el.html('<div class="gl-missing">Panel missing: ' + id + "</div>");
    }

    container.on("resize", function () {
      if (id === "map" && global.map) {
        try { global.map.invalidateSize(); } catch (_) {}
      }
    });
    container.on("show", function () {
      if (id === "map" && global.map) {
        setTimeout(function () {
          try { global.map.invalidateSize(); } catch (_) {}
        }, 100);
      }
    });
  }

  function registerComponents(gl) {
    COMPONENT_IDS.forEach(function (id) {
      gl.registerComponent(id, function (container) {
        mountPanel(container, id);
      });
    });
  }

  function saveLayout() {
    if (!layout) return null;
    try {
      const cfg = layout.toConfig();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
      return cfg;
    } catch (e) {
      console.warn("saveLayout", e);
      return null;
    }
  }

  function exportLayout() {
    const cfg = saveLayout() || defaultConfig();
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tides-currents-xplr-layout-" + Date.now() + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function loadLayoutFromObject(cfg) {
    if (!cfg) return false;
    try {
      if (layout) {
        layout.destroy();
        layout = null;
      }
      // Return panels to store before re-mount
      const store = document.getElementById("panelStore");
      COMPONENT_IDS.forEach(function (id) {
        const p = document.getElementById("panel-" + id);
        if (p && store) store.appendChild(p);
      });
      const root = document.getElementById("glRoot");
      layout = new GoldenLayout(cfg, $(root));
      registerComponents(layout);
      layout.init();
      bindLayoutEvents();
      setTimeout(function () {
        if (global.map) try { global.map.invalidateSize(); } catch (_) {}
      }, 200);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
      return true;
    } catch (e) {
      console.warn("loadLayout", e);
      return false;
    }
  }

  function resetLayout() {
    localStorage.removeItem(STORAGE_KEY);
    loadLayoutFromObject(defaultConfig());
  }

  function bindLayoutEvents() {
    if (!layout) return;
    layout.on("stateChanged", function () {
      // debounce persist
      clearTimeout(bindLayoutEvents._t);
      bindLayoutEvents._t = setTimeout(function () {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(layout.toConfig()));
        } catch (_) {}
      }, 400);
    });
    layout.on("itemDestroyed", function () {
      setTimeout(function () {
        if (global.map) try { global.map.invalidateSize(); } catch (_) {}
      }, 100);
    });
  }

  function bindToolbar() {
    const toast = function (m) {
      if (typeof global.showToast === "function") global.showToast(m);
      else console.log(m);
    };
    document.getElementById("saveLayoutBtn")?.addEventListener("click", function () {
      if (saveLayout()) toast("Docking layout saved");
      else toast("Save failed");
    });
    document.getElementById("exportLayoutBtn")?.addEventListener("click", function () {
      exportLayout();
      toast("Layout JSON exported");
    });
    document.getElementById("resetLayoutBtn")?.addEventListener("click", function () {
      resetLayout();
      toast("Default docking layout restored");
    });
    document.getElementById("loadLayoutBtn")?.addEventListener("click", function () {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        try {
          loadLayoutFromObject(JSON.parse(raw));
          toast("Layout loaded");
        } catch (_) {
          toast("Corrupt layout — reset");
        }
      } else {
        document.getElementById("layoutFileInput")?.click();
      }
    });
    document.getElementById("loadLayoutBtn")?.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      document.getElementById("layoutFileInput")?.click();
    });
    document.getElementById("layoutFileInput")?.addEventListener("change", function (e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function () {
        try {
          loadLayoutFromObject(JSON.parse(reader.result));
          toast("Layout file applied");
        } catch (_) {
          toast("Invalid layout JSON");
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    });
  }

  function initDockingLayout() {
    const root = document.getElementById("glRoot");
    if (!root || typeof GoldenLayout === "undefined") {
      console.error("Golden Layout not available");
      return null;
    }

    let cfg = defaultConfig();
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) cfg = JSON.parse(saved);
    } catch (_) {}

    layout = new GoldenLayout(cfg, $(root));
    registerComponents(layout);

    layout.on("initialised", function () {
      bindLayoutEvents();
      setTimeout(function () {
        if (global.map) try { global.map.invalidateSize(); } catch (_) {}
        $(window).trigger("resize");
      }, 150);
    });

    try {
      layout.init();
    } catch (e) {
      console.warn("Layout init failed, using default", e);
      localStorage.removeItem(STORAGE_KEY);
      layout = new GoldenLayout(defaultConfig(), $(root));
      registerComponents(layout);
      layout.init();
      bindLayoutEvents();
    }

    $(window).on("resize", function () {
      if (layout) layout.updateSize();
      if (global.map) try { global.map.invalidateSize(); } catch (_) {}
    });

    bindToolbar();
    global.tcxLayout = {
      save: saveLayout,
      export: exportLayout,
      reset: resetLayout,
      load: loadLayoutFromObject,
      get: function () { return layout; },
      toJSON: function () {
        return layout ? JSON.stringify(layout.toConfig(), null, 2) : null;
      }
    };
    return layout;
  }

  global.initDockingLayout = initDockingLayout;
})(window);

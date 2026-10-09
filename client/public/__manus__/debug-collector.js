(function () {
  "use strict";

  if (window.__MANUS_DEBUG_COLLECTOR__) return;

  const CONFIG = {
    reportEndpoint: "/__manus__/logs",
    bufferSize: {
      console: 500,
      network: 200,
    
      ui: 500,
    },
    reportInterval: 2000,
    sensitiveFields: [
      "password",
      "token",
      "secret",
      "key",
      "authorization",
      "cookie",
      "session",
    ],
    maxBodyLength: 10240,
  
    uiInputMaxLen: 200,
    uiTextMaxLen: 80,

    scrollThrottleMs: 500,
  };

  const store = {
    consoleLogs: [],
    networkRequests: [],
    uiEvents: [],
    lastReportTime: Date.now(),
    lastScrollTime: 0,
  };

  function sanitizeValue(value, depth) {
    if (depth === void 0) depth = 0;
    if (depth > 5) return "[Max Depth]";
    if (value === null) return null;
    if (value === undefined) return undefined;

    if (typeof value === "string") {
      return value.length > 1000 ? value.slice(0, 1000) + "...[truncated]" : value;
    }

    if (typeof value !== "object") return value;

    if (Array.isArray(value)) {
      return value.slice(0, 100).map(function (v) {
        return sanitizeValue(v, depth + 1);
      });
    }

    var sanitized = {};
    for (var k in value) {
      if (Object.prototype.hasOwnProperty.call(value, k)) {
        var isSensitive = CONFIG.sensitiveFields.some(function (f) {
          return k.toLowerCase().indexOf(f) !== -1;
        });
        if (isSensitive) {
          sanitized[k] = "[REDACTED]";
        } else {
          sanitized[k] = sanitizeValue(value[k], depth + 1);
        }
      }
    }
    return sanitized;
  }

  function formatArg(arg) {
    try {
      if (arg instanceof Error) {
        return { type: "Error", message: arg.message, stack: arg.stack };
      }
      if (typeof arg === "object") return sanitizeValue(arg);
      return String(arg);
    } catch (e) {
      return "[Unserializable]";
    }
  }

  function formatArgs(args) {
    var result = [];
    for (var i = 0; i < args.length; i++) result.push(formatArg(args[i]));
    return result;
  }

  function pruneBuffer(buffer, maxSize) {
    if (buffer.length > maxSize) buffer.splice(0, buffer.length - maxSize);
  }

  function tryParseJson(str) {
    if (typeof str !== "string") return str;
    try {
      return JSON.parse(str);
    } catch (e) {
      return str;
    }
  }



  function shouldIgnoreTarget(target) {
    try {
      if (!target || !(target instanceof Element)) return false;
      return !!target.closest(".manus-no-record");
    } catch (e) {
      return false;
    }
  }

  function compactText(s, maxLen) {
    try {
      var t = (s || "").trim().replace(/\s+/g, " ");
      if (!t) return "";
      return t.length > maxLen ? t.slice(0, maxLen) + "…" : t;
    } catch (e) {
      return "";
    }
  }

  function elText(el) {
    try {
      var t = el.innerText || el.textContent || "";
      return compactText(t, CONFIG.uiTextMaxLen);
    } catch (e) {
      return "";
    }
  }

  function describeElement(el) {
    if (!el || !(el instanceof Element)) return null;

    var getAttr = function (name) {
      return el.getAttribute(name);
    };

    var tag = el.tagName ? el.tagName.toLowerCase() : null;
    var id = el.id || null;
    var name = getAttr("name") || null;
    var role = getAttr("role") || null;
    var ariaLabel = getAttr("aria-label") || null;

    var dataLoc = getAttr("data-loc") || null;
    var testId =
      getAttr("data-testid") ||
      getAttr("data-test-id") ||
      getAttr("data-test") ||
      null;

    var type = tag === "input" ? (getAttr("type") || "text") : null;
    var href = tag === "a" ? getAttr("href") || null : null;

    var selectorHint = null;
    if (testId) selectorHint = '[data-testid="' + testId + '"]';
    else if (dataLoc) selectorHint = '[data-loc="' + dataLoc + '"]';
    else if (id) selectorHint = "#" + id;
    else selectorHint = tag || "unknown";

    return {
      tag: tag,
      id: id,
      name: name,
      type: type,
      role: role,
      ariaLabel: ariaLabel,
      testId: testId,
      dataLoc: dataLoc,
      href: href,
      text: elText(el),
      selectorHint: selectorHint,
    };
  }

  function isSensitiveField(el) {
    if (!el || !(el instanceof Element)) return false;
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag !== "input" && tag !== "textarea") return false;

    var type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password") return true;

    var name = (el.getAttribute("name") || "").toLowerCase();
    var id = (el.id || "").toLowerCase();

    return CONFIG.sensitiveFields.some(function (f) {
      return name.indexOf(f) !== -1 || id.indexOf(f) !== -1;
    });
  }

  function getInputValueSafe(el) {
    if (!el || !(el instanceof Element)) return null;
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag !== "input" && tag !== "textarea" && tag !== "select") return null;

    var v = "";
    try {
      v = el.value != null ? String(el.value) : "";
    } catch (e) {
      v = "";
    }

    if (isSensitiveField(el)) return { masked: true, length: v.length };

    if (v.length > CONFIG.uiInputMaxLen) v = v.slice(0, CONFIG.uiInputMaxLen) + "…";
    return v;
  }

  function logUiEvent(kind, payload) {
    var entry = {
      timestamp: Date.now(),
      kind: kind,
      url: location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      payload: sanitizeValue(payload),
    };
    store.uiEvents.push(entry);
    pruneBuffer(store.uiEvents, CONFIG.bufferSize.ui);
  }

  function installUiEventListeners() {
    document.addEventListener(
      "click",
      function (e) {
        var t = e.target;
        if (shouldIgnoreTarget(t)) return;
        logUiEvent("click", {
          target: describeElement(t),
          x: e.clientX,
          y: e.clientY,
        });
      },
      true
    );

    document.addEventListener(
      "change",
      function (e) {
        var t = e.target;
        if (shouldIgnoreTarget(t)) return;
        logUiEvent("change", {
          target: describeElement(t),
          value: getInputValueSafe(t),
        });
      },
      true
    );

    document.addEventListener(
      "focusin",
      function (e) {
        var t = e.target;
        if (shouldIgnoreTarget(t)) return;
        logUiEvent("focusin", { target: describeElement(t) });
      },
      true
    );

    document.addEventListener(
      "focusout",
      function (e) {
        var t = e.target;
        if (shouldIgnoreTarget(t)) return;
        logUiEvent("focusout", {
          target: describeElement(t),
          value: getInputValueSafe(t),
        });
      },
      true
    );

    document.addEventListener(
      "keydown",
      function (e) {
        if (e.key !== "Enter" && e.key !== "Escape") return;
        var t = e.target;
        if (shouldIgnoreTarget(t)) return;
        logUiEvent("keydown", { key: e.key, target: describeElement(t) });
      },
      true
    );

    document.addEventListener(
      "submit",
      function (e) {
        var t = e.target;
        if (shouldIgnoreTarget(t)) return;
        logUiEvent("submit", { target: describeElement(t) });
      },
      true
    );

    window.addEventListener(
      "scroll",
      function () {
        var now = Date.now();
        if (now - store.lastScrollTime < CONFIG.scrollThrottleMs) return;
        store.lastScrollTime = now;

        logUiEvent("scroll", {
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          documentHeight: document.documentElement.scrollHeight,
          viewportHeight: window.innerHeight,
        });
      },
      { passive: true }
    );

    function nav(reason) {
      logUiEvent("navigate", { reason: reason });
    }

    var origPush = history.pushState;
    history.pushState = function () {
      origPush.apply(this, arguments);
      nav("pushState");
    };

    var origReplace = history.replaceState;
    history.replaceState = function () {
      origReplace.apply(this, arguments);
      nav("replaceState");
    };

    window.addEventListener("popstate", function () {
      nav("popstate");
    });
    window.addEventListener("hashchange", function () {
      nav("hashchange");
    });
  }

  var originalConsole = {
    log: console.log.bind(console),
    debug: console.debug.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  ["log", "debug", "info", "warn", "error"].forEach(function (method) {
    console[method] = function () {
      var args = Array.prototype.slice.call(arguments);

      var entry = {
        timestamp: Date.now(),
        level: method.toUpperCase(),
        args: formatArgs(args),
        stack: method === "error" ? new Error().stack : null,
      };

      store.consoleLogs.push(entry);
      pruneBuffer(store.consoleLogs, CONFIG.bufferSize.console);

      originalConsole[method].apply(console, args);
    };
  });

  window.addEventListener("error", function (event) {
    store.consoleLogs.push({
      timestamp: Date.now(),
      level: "ERROR",
      args: [
        {
          type: "UncaughtError",
          message: event.message,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          stack: event.error ? event.error.stack : null,
        },
      ],
      stack: event.error ? event.error.stack : null,
    });
    pruneBuffer(store.consoleLogs, CONFIG.bufferSize.console);

    logUiEvent("error", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    store.consoleLogs.push({
      timestamp: Date.now(),
      level: "ERROR",
      args: [
        {
          type: "UnhandledRejection",
          reason: reason && reason.message ? reason.message : String(reason),
          stack: reason && reason.stack ? reason.stack : null,
        },
      ],
      stack: reason && reason.stack ? reason.stack : null,
    });
    pruneBuffer(store.consoleLogs, CONFIG.bufferSize.console);

    logUiEvent("unhandledrejection", {
      reason: reason && reason.message ? reason.message : String(reason),
    });
  });


  var originalFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    init = init || {};
    var startTime = Date.now();
    var url = typeof input === "string"
      ? input
      : (input && (input.url || input.href || String(input))) || "";
    var method = init.method || (input && input.method) || "GET";

    if (url.indexOf("/__manus__/") === 0) {
      return originalFetch(input, init);
    }

    var requestHeaders = {};
    try {
      if (init.headers) {
        requestHeaders = Object.fromEntries(new Headers(init.headers).entries());
      }
    } catch (e) {
      requestHeaders = { _parseError: true };
    }

    var entry = {
      timestamp: startTime,
      type: "fetch",
      method: method.toUpperCase(),
      url: url,
      request: {
        headers: requestHeaders,
        body: init.body ? sanitizeValue(tryParseJson(init.body)) : null,
      },
      response: null,
      duration: null,
      error: null,
    };

    return originalFetch(input, init)
      .then(function (response) {
        entry.duration = Date.now() - startTime;

        var contentType = (response.headers.get("content-type") || "").toLowerCase();
        var contentLength = response.headers.get("content-length");

        entry.response = {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: null,
        };

        if (response.status >= 400) {
          logUiEvent("network_error", {
            kind: "fetch",
            method: entry.method,
            url: entry.url,
            status: response.status,
            statusText: response.statusText,
          });
        }

        var isStreaming = contentType.indexOf("text/event-stream") !== -1 ||
                          contentType.indexOf("application/stream") !== -1 ||
                          contentType.indexOf("application/x-ndjson") !== -1;
        if (isStreaming) {
          entry.response.body = "[Streaming response - not captured]";
          store.networkRequests.push(entry);
          pruneBuffer(store.networkRequests, CONFIG.bufferSize.network);
          return response;
        }

        if (contentLength && parseInt(contentLength, 10) > CONFIG.maxBodyLength) {
          entry.response.body = "[Response too large: " + contentLength + " bytes]";
          store.networkRequests.push(entry);
          pruneBuffer(store.networkRequests, CONFIG.bufferSize.network);
          return response;
        }

        var isBinary = contentType.indexOf("image/") !== -1 ||
                       contentType.indexOf("video/") !== -1 ||
                       contentType.indexOf("audio/") !== -1 ||
                       contentType.indexOf("application/octet-stream") !== -1 ||
                       contentType.indexOf("application/pdf") !== -1 ||
                       contentType.indexOf("application/zip") !== -1;
        if (isBinary) {
          entry.response.body = "[Binary content: " + contentType + "]";
          store.networkRequests.push(entry);
          pruneBuffer(store.networkRequests, CONFIG.bufferSize.network);
          return response;
        }

        var clonedResponse = response.clone();

        clonedResponse
          .text()
          .then(function (text) {
            if (text.length <= CONFIG.maxBodyLength) {
              entry.response.body = sanitizeValue(tryParseJson(text));
            } else {
              entry.response.body = text.slice(0, CONFIG.maxBodyLength) + "...[truncated]";
            }
          })
          .catch(function () {
            entry.response.body = "[Unable to read body]";
          })
          .finally(function () {
            store.networkRequests.push(entry);
            pruneBuffer(store.networkRequests, CONFIG.bufferSize.network);
          });

        return response;
      })
      .catch(function (error) {
        entry.duration = Date.now() - startTime;
        entry.error = { message: error.message, stack: error.stack };

        store.networkRequests.push(entry);
        pruneBuffer(store.networkRequests, CONFIG.bufferSize.network);

        logUiEvent("network_error", {
          kind: "fetch",
          method: entry.method,
          url: entry.url,
          message: error.message,
        });

        throw error;
      });
  };

  var originalXHROpen = XMLHttpRequest.prototype.open;
  var originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._manusData = {
      method: (method || "GET").toUpperCase(),
      url: url,
      startTime: null,
    };
    return originalXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;

    if (
      xhr._manusData &&
      xhr._manusData.url &&
      xhr._manusData.url.indexOf("/__manus__/") !== 0
    ) {
      xhr._manusData.startTime = Date.now();
      xhr._manusData.requestBody = body ? sanitizeValue(tryParseJson(body)) : null;

      xhr.addEventListener("load", function () {
        var contentType = (xhr.getResponseHeader("content-type") || "").toLowerCase();
        var responseBody = null;

        var isStreaming = contentType.indexOf("text/event-stream") !== -1 ||
                          contentType.indexOf("application/stream") !== -1 ||
                          contentType.indexOf("application/x-ndjson") !== -1;

        var isBinary = contentType.indexOf("image/") !== -1 ||
                       contentType.indexOf("video/") !== -1 ||
                       contentType.indexOf("audio/") !== -1 ||
                       contentType.indexOf("application/octet-stream") !== -1 ||
                       contentType.indexOf("application/pdf") !== -1 ||
                       contentType.indexOf("application/zip") !== -1;

        if (isStreaming) {
          responseBody = "[Streaming response - not captured]";
        } else if (isBinary) {
          responseBody = "[Binary content: " + contentType + "]";
        } else {
          try {
            var text = xhr.responseText || "";
            if (text.length > CONFIG.maxBodyLength) {
              responseBody = text.slice(0, CONFIG.maxBodyLength) + "...[truncated]";
            } else {
              responseBody = sanitizeValue(tryParseJson(text));
            }
          } catch (e) {
            responseBody = "[Unable to read response: " + e.message + "]";
          }
        }

        var entry = {
          timestamp: xhr._manusData.startTime,
          type: "xhr",
          method: xhr._manusData.method,
          url: xhr._manusData.url,
          request: { body: xhr._manusData.requestBody },
          response: {
            status: xhr.status,
            statusText: xhr.statusText,
            body: responseBody,
          },
          duration: Date.now() - xhr._manusData.startTime,
          error: null,
        };

        store.networkRequests.push(entry);
        pruneBuffer(store.networkRequests, CONFIG.bufferSize.network);

        if (entry.response && entry.response.status >= 400) {
          logUiEvent("network_error", {
            kind: "xhr",
            method: entry.method,
            url: entry.url,
            status: entry.response.status,
            statusText: entry.response.statusText,
          });
        }
      });

      xhr.addEventListener("error", function () {
        var entry = {
          timestamp: xhr._manusData.startTime,
          type: "xhr",
          method: xhr._manusData.method,
          url: xhr._manusData.url,
          request: { body: xhr._manusData.requestBody },
          response: null,
          duration: Date.now() - xhr._manusData.startTime,
          error: { message: "Network error" },
        };

        store.networkRequests.push(entry);
        pruneBuffer(store.networkRequests, CONFIG.bufferSize.network);

        logUiEvent("network_error", {
          kind: "xhr",
          method: entry.method,
          url: entry.url,
          message: "Network error",
        });
      });
    }

    return originalXHRSend.apply(this, arguments);
  };


  function reportLogs() {
    var consoleLogs = store.consoleLogs.splice(0);
    var networkRequests = store.networkRequests.splice(0);
    var uiEvents = store.uiEvents.splice(0);

    if (
      consoleLogs.length === 0 &&
      networkRequests.length === 0 &&
      uiEvents.length === 0
    ) {
      return Promise.resolve();
    }

    var payload = {
      timestamp: Date.now(),
      consoleLogs: consoleLogs,
      networkRequests: networkRequests,
      sessionEvents: uiEvents,
      uiEvents: uiEvents,
    };

    return originalFetch(CONFIG.reportEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(function () {
      store.consoleLogs = consoleLogs.concat(store.consoleLogs);
      store.networkRequests = networkRequests.concat(store.networkRequests);
      store.uiEvents = uiEvents.concat(store.uiEvents);

      pruneBuffer(store.consoleLogs, CONFIG.bufferSize.console);
      pruneBuffer(store.networkRequests, CONFIG.bufferSize.network);
      pruneBuffer(store.uiEvents, CONFIG.bufferSize.ui);
    });
  }

  setInterval(reportLogs, CONFIG.reportInterval);

  window.addEventListener("beforeunload", function () {
    var consoleLogs = store.consoleLogs;
    var networkRequests = store.networkRequests;
    var uiEvents = store.uiEvents;

    if (
      consoleLogs.length === 0 &&
      networkRequests.length === 0 &&
      uiEvents.length === 0
    ) {
      return;
    }

    var payload = {
      timestamp: Date.now(),
      consoleLogs: consoleLogs,
      networkRequests: networkRequests,
      sessionEvents: uiEvents,
      uiEvents: uiEvents,
    };

    if (navigator.sendBeacon) {
      var payloadStr = JSON.stringify(payload);
      var MAX_BEACON_SIZE = 60000; 
      if (payloadStr.length > MAX_BEACON_SIZE) {
        var truncatedPayload = {
          timestamp: Date.now(),
          consoleLogs: consoleLogs.slice(-50),
          networkRequests: networkRequests.slice(-20),
          sessionEvents: uiEvents.slice(-100),
          uiEvents: uiEvents.slice(-100),
          _truncated: true,
        };
        payloadStr = JSON.stringify(truncatedPayload);
      }
      navigator.sendBeacon(CONFIG.reportEndpoint, payloadStr);
    }
  });


  try {
    installUiEventListeners();
  } catch (e) {
    console.warn("[Manus] Failed to install UI listeners:", e);
  }

  window.__MANUS_DEBUG_COLLECTOR__ = {
    version: "2.0-no-rrweb",
    store: store,
    forceReport: reportLogs,
  };

  console.debug("[Manus] Debug collector initialized (no rrweb, UI events only)");
})();

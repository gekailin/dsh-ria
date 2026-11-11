// dsh-super-session client half: one sidebar entry that opens the global Super
// Session as an ordinary session view, plus a small WeChat chip on that entry.
window.__ModuleLoader__.load({
  id: "dsh-super-session",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var ReactDOM = require("react-dom");

    var API = "/plugins/dsh-super-session/api";
    var PANEL_ID = "super-session";
    var LOGIN_PHASES = ["connecting", "waiting", "scanned", "starting"];

    function SuperIcon(props) {
      var size = props && typeof props.size === "number" ? props.size : 18;
      return React.createElement(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          "aria-hidden": "true",
          style: { display: "block" }
        },
        React.createElement("path", {
          d: "M4 7h16M4 12h10M4 17h7",
          stroke: "currentColor",
          strokeWidth: 1.8,
          strokeLinecap: "round"
        }),
        React.createElement("circle", {
          cx: 18,
          cy: 16,
          r: 3,
          stroke: "currentColor",
          strokeWidth: 1.8
        })
      );
    }

    async function openKnown(ctx, sessionId) {
      var sessions = ctx.sessions;
      if (sessions && typeof sessions.refresh === "function") {
        var phase;
        var byId;
        try {
          var snap = sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : undefined;
          phase = snap && snap.phase;
          byId = snap && snap.byId;
        } catch (_error) {
          phase = undefined;
          byId = undefined;
        }
        if (phase !== "ready" || !byId || !byId[sessionId]) {
          await sessions.refresh();
        }
      }
      await ctx.uiWorkspace.openSession(sessionId);
    }

    function api(path, method, payload) {
      var init = {
        method: method || "GET",
        credentials: "same-origin"
      };
      if (init.method !== "GET") {
        init.headers = { "x-dsh-super-session": "1" };
      }
      if (payload !== undefined) {
        init.headers = Object.assign({}, init.headers, { "content-type": "application/json" });
        init.body = JSON.stringify(payload);
      }
      return fetch(API + path, init).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok) throw new Error(body.error || "HTTP " + response.status);
          return body;
        });
      });
    }

    function messageOf(error) {
      return String(error && error.message ? error.message : error);
    }

    function formatPauseTime(value) {
      if (!value) return "";
      var date = new Date(value);
      if (isNaN(date.getTime())) return String(value);
      function pad(number) { return number < 10 ? "0" + number : String(number); }
      return (date.getMonth() + 1) + "月" + date.getDate() + "日 " + pad(date.getHours()) + ":" + pad(date.getMinutes());
    }

    function pauseSourceText(status) {
      if (status && status.pausedBy === "manual") return "手动";
      if (status && status.pausedBy === "channel") {
        return "自动（" + (status.pauseReason || "非微信通道消息") + "）";
      }
      return "未知来源";
    }

    function WechatDialog(props) {
      var onClose = props.onClose;
      var state = React.useState(props.initial || null);
      var status = state[0];
      var setStatus = state[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = React.useState("");
      var error = errorState[0];
      var setError = errorState[1];
      var auto = React.useRef(false);
      var noticeState = React.useState("");
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var noticeTimer = React.useRef(null);
      var primed = React.useRef(Boolean(props.initial));
      var lastPaused = React.useRef(Boolean(props.initial && props.initial.paused));

      function applyStatus(body) {
        setStatus(body);
        var paused = Boolean(body && body.paused);
        var wasPaused = lastPaused.current;
        var known = primed.current;
        lastPaused.current = paused;
        primed.current = true;
        if (known && !wasPaused && paused && body && body.pausedBy === "channel") {
          setNotice("已自动暂停推送：检测到非微信通道消息");
          if (noticeTimer.current) clearTimeout(noticeTimer.current);
          noticeTimer.current = setTimeout(function () { setNotice(""); }, 8000);
        }
      }

      React.useEffect(function () {
        var cancelled = false;
        function tick() {
          if (cancelled) return;
          api("/wechat/status")
            .then(function (body) { if (!cancelled) applyStatus(body); })
            .catch(function (failure) {
              if (!cancelled) setStatus({ ok: false, loggedIn: false, login: { phase: "error", message: messageOf(failure) } });
            });
        }
        tick();
        var timer = setInterval(tick, 2000);
        return function () {
          cancelled = true;
          clearInterval(timer);
          if (noticeTimer.current) clearTimeout(noticeTimer.current);
        };
      }, []);

      React.useEffect(function () {
        function onKey(event) {
          if (event.key === "Escape") onClose();
        }
        window.addEventListener("keydown", onKey);
        return function () { window.removeEventListener("keydown", onKey); };
      }, [onClose]);

      function act(path, payload) {
        setBusy(true);
        setError("");
        api(path, "POST", payload)
          .then(function (body) { applyStatus(body); })
          .catch(function (failure) { setError(messageOf(failure)); })
          .finally(function () { setBusy(false); });
      }

      React.useEffect(function () {
        if (!status || status.loggedIn || auto.current) return;
        var phase = status.login && status.login.phase;
        if (LOGIN_PHASES.indexOf(phase) >= 0) {
          auto.current = true;
          return;
        }
        auto.current = true;
        act("/wechat/login");
      }, [status]);

      var login = status && status.login ? status.login : { phase: "idle", message: "" };
      var phase = login.phase || "idle";
      var connecting = busy || phase === "connecting" || phase === "starting";
      var dotColor = "#9ca3af";
      if (status && status.paused) dotColor = "#f59e0b";
      else if (status && status.loggedIn) dotColor = "#22c55e";
      else if (phase === "error") dotColor = "#ef4444";
      else if (LOGIN_PHASES.indexOf(phase) >= 0) dotColor = "#f59e0b";

      var cardStyle = {
        width: "360px",
        maxWidth: "calc(100vw - 40px)",
        maxHeight: "calc(100vh - 80px)",
        overflow: "auto",
        padding: "18px",
        borderRadius: "12px",
        background: "var(--dsh-bg-elevated, #fff)",
        color: "var(--dsh-text-primary, #111)",
        boxShadow: "0 20px 60px rgba(0, 0, 0, 0.28)",
        fontFamily: "inherit"
      };
      var buttonStyle = {
        padding: "7px 13px",
        borderRadius: "7px",
        border: "1px solid var(--dsh-border, #d1d5db)",
        background: "transparent",
        color: "inherit",
        cursor: busy ? "default" : "pointer",
        fontSize: "12px"
      };
      var paused = Boolean(status && status.paused);
      var pauseAt = paused && status && status.pausedAt ? formatPauseTime(status.pausedAt) : "";
      var pauseButtonStyle = {
        padding: "6px 11px",
        borderRadius: "7px",
        border: paused ? "1px solid rgba(245, 158, 11, 0.55)" : "1px solid var(--dsh-border, #d1d5db)",
        background: paused ? "rgba(245, 158, 11, 0.12)" : "transparent",
        color: "inherit",
        cursor: busy ? "default" : "pointer",
        fontSize: "12px",
        whiteSpace: "nowrap",
        flex: "0 0 auto"
      };
      function togglePause() {
        if (busy) return;
        act("/wechat/pause", paused ? { paused: false } : { paused: true, reason: "用户手动暂停推送" });
      }

      var body;
      if (status && status.loggedIn) {
        body = React.createElement(
          "div",
          null,
          React.createElement("div", { style: { fontSize: "13px", lineHeight: "1.7" } },
            "已连接微信：",
            React.createElement("strong", null, status.nick || status.user || "当前账号")
          ),
          React.createElement(
            "div",
            {
              role: "status",
              "aria-live": "polite",
              style: {
                marginTop: "12px",
                padding: "10px 12px",
                borderRadius: "9px",
                border: paused ? "1px solid rgba(245, 158, 11, 0.32)" : "1px solid var(--dsh-border, #e5e7eb)",
                background: paused ? "rgba(245, 158, 11, 0.08)" : "rgba(156, 163, 175, 0.08)"
              }
            },
            React.createElement(
              "div",
              { style: { display: "flex", alignItems: "flex-start", gap: "9px" } },
              React.createElement("span", {
                style: {
                  width: "8px",
                  height: "8px",
                  marginTop: "5px",
                  borderRadius: "50%",
                  background: paused ? "#f59e0b" : "#9ca3af",
                  boxShadow: paused ? "0 0 0 3px rgba(245, 158, 11, 0.16)" : "none",
                  flex: "0 0 auto"
                }
              }),
              React.createElement(
                "div",
                { style: { flex: "1", minWidth: "0" } },
                React.createElement("div", { style: { fontSize: "13px", fontWeight: "600", lineHeight: "1.4" } },
                  paused ? "已暂停推送" : "推送中"
                ),
                React.createElement("div", { style: { marginTop: "3px", fontSize: "11px", lineHeight: "1.6", color: "var(--dsh-text-secondary, #666)" } },
                  paused
                    ? "来源：" + pauseSourceText(status) + (pauseAt ? " · 暂停于 " + pauseAt : "")
                    : "Super 的回复会同步到微信。"
                )
              ),
              React.createElement("button", {
                type: "button",
                disabled: busy,
                "aria-label": paused ? "恢复微信推送" : "暂停微信推送",
                title: paused ? "恢复 Super 回复同步到微信" : "暂停 Super 回复同步到微信",
                style: pauseButtonStyle,
                onClick: togglePause
              }, busy ? "正在保存…" : (paused ? "恢复推送" : "暂停推送"))
            ),
            paused ? React.createElement("div", { style: { marginTop: "8px", fontSize: "11px", lineHeight: "1.6", color: "var(--dsh-text-secondary, #666)" } },
              "只停出站推送；连接、登录和微信入站消息不受影响。"
            ) : null
          ),
          React.createElement("div", { style: { marginTop: "8px", fontSize: "12px", lineHeight: "1.6", color: "var(--dsh-text-secondary, #666)" } },
            "发给 Super Session 的微信消息会原样进入会话；Super 的每条回复也会同步回微信。"
          ),
          React.createElement("div", { style: { marginTop: "16px", display: "flex", justifyContent: "flex-end", gap: "8px" } },
            React.createElement("button", {
              type: "button",
              disabled: busy,
              style: buttonStyle,
              onClick: function () { act("/wechat/logout"); }
            }, busy ? "正在退出…" : "退出登录")
          )
        );
      } else {
        body = React.createElement(
          "div",
          null,
          login.qr ? React.createElement("div", { style: { marginTop: "14px", textAlign: "center" } },
            React.createElement("img", {
              src: login.qr,
              alt: "微信登录二维码",
              width: 190,
              height: 190,
              style: { width: "190px", height: "190px", background: "#fff", borderRadius: "8px" }
            })
          ) : null,
          React.createElement("div", { style: { marginTop: "12px", fontSize: "13px", lineHeight: "1.6", textAlign: "center" } },
            connecting ? "正在连接微信…" : (login.message || "尚未连接微信")
          ),
          phase === "scanned" ? React.createElement("div", { style: { marginTop: "4px", fontSize: "12px", color: "#f59e0b", textAlign: "center" } }, "已扫码，请在手机上确认") : null,
          error ? React.createElement("div", { style: { marginTop: "10px", fontSize: "12px", color: "#ef4444" } }, error) : null,
          React.createElement("div", { style: { marginTop: "16px", display: "flex", justifyContent: "center" } },
            React.createElement("button", {
              type: "button",
              disabled: busy,
              style: buttonStyle,
              onClick: function () { act("/wechat/login"); }
            }, busy ? "正在获取…" : (login.qr ? "刷新二维码" : "连接微信"))
          )
        );
      }

      return ReactDOM.createPortal(
        React.createElement(
          "div",
          {
            role: "presentation",
            onClick: function (event) { if (event.target === event.currentTarget) onClose(); },
            style: {
              position: "fixed",
              inset: "0",
              zIndex: "10000",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(0, 0, 0, 0.35)"
            }
          },
          React.createElement(
            "div",
            { role: "dialog", "aria-modal": "true", "aria-label": "微信连接", style: cardStyle },
            React.createElement(
              "div",
              { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" } },
              React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "15px", fontWeight: "600" } },
                React.createElement("span", { style: { width: "8px", height: "8px", borderRadius: "50%", background: dotColor, display: "inline-block" } }),
                "微信连接"
              ),
              React.createElement("button", {
                type: "button",
                "aria-label": "关闭",
                onClick: onClose,
                style: { border: "0", background: "transparent", color: "inherit", fontSize: "18px", cursor: "pointer", lineHeight: "1" }
              }, "×")
            ),
            notice ? React.createElement(
              "div",
              {
                role: "status",
                "aria-live": "polite",
                style: {
                  marginTop: "10px",
                  padding: "8px 10px",
                  borderRadius: "8px",
                  border: "1px solid rgba(245, 158, 11, 0.28)",
                  background: "rgba(245, 158, 11, 0.10)",
                  fontSize: "12px",
                  lineHeight: "1.6"
                }
              },
              notice
            ) : null,
            body,
            React.createElement("div", { style: { marginTop: "16px", paddingTop: "12px", borderTop: "1px solid var(--dsh-border, #e5e7eb)", fontSize: "11px", lineHeight: "1.6", color: "var(--dsh-text-secondary, #888)" } },
              "使用微信「文件传输助手」网页版。只接收文本消息；图片和文件请在 Super Session 里直接发送。"
            )
          )
        ),
        document.body
      );
    }

    function SuperPanelEntry(props) {
      var ctx = props.ctx;
      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var statusState = React.useState(null);
      var status = statusState[0];
      var setStatus = statusState[1];
      var toastState = React.useState("");
      var toast = toastState[0];
      var setToast = toastState[1];
      var glyphRef = React.useRef(null);
      var chipRef = React.useRef(null);
      var toastTimer = React.useRef(null);
      var primed = React.useRef(false);
      var lastPaused = React.useRef(false);

      function applyStatus(body) {
        setStatus(body);
        var paused = Boolean(body && body.paused);
        var wasPaused = lastPaused.current;
        var known = primed.current;
        lastPaused.current = paused;
        primed.current = true;
        if (known && !wasPaused && paused && body && body.pausedBy === "channel") {
          setToast("已自动暂停推送：检测到非微信通道消息");
          if (toastTimer.current) clearTimeout(toastTimer.current);
          toastTimer.current = setTimeout(function () { setToast(""); }, 8000);
        }
      }

      React.useEffect(function () {
        var cancelled = false;
        function tick() {
          if (cancelled || document.hidden) return;
          api("/wechat/status")
            .then(function (body) { if (!cancelled) applyStatus(body); })
            .catch(function () { if (!cancelled) setStatus({ ok: false, loggedIn: false, login: { phase: "error", message: "" } }); });
        }
        tick();
        var timer = setInterval(tick, 15000);
        window.addEventListener("focus", tick);
        return function () {
          cancelled = true;
          clearInterval(timer);
          if (toastTimer.current) clearTimeout(toastTimer.current);
          window.removeEventListener("focus", tick);
        };
      }, []);

      React.useEffect(function () {
        var glyph = glyphRef.current;
        if (!glyph) return;
        var row = glyph.closest("button") || glyph.closest('[role="button"]');
        if (!row) return;

        var chip = document.createElement("span");
        chip.setAttribute("role", "button");
        chip.setAttribute("tabindex", "0");
        chip.setAttribute("aria-label", "微信连接");
        chip.style.cssText = "display:inline-flex;align-items:center;gap:4px;height:19px;padding:0 6px;margin-left:6px;border:1px solid var(--dsh-border, #d1d5db);border-radius:999px;font-size:10px;line-height:1;color:var(--dsh-text-secondary, #666);cursor:pointer;flex:0 0 auto;background:transparent;";
        var dot = document.createElement("span");
        dot.setAttribute("data-dot", "1");
        dot.style.cssText = "width:6px;height:6px;border-radius:50%;background:#9ca3af;display:inline-block;";
        var label = document.createElement("span");
        label.setAttribute("data-label", "1");
        label.textContent = "微信";
        chip.appendChild(dot);
        chip.appendChild(label);
        chipRef.current = chip;

        function activate(event) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }
        chip.addEventListener("click", activate);
        chip.addEventListener("keydown", function (event) {
          if (event.key === "Enter" || event.key === " ") activate(event);
        });

        function place() {
          var title = row.querySelector('[class*="panelTitle"]');
          if (!title) {
            // Collapsed sidebar: the row is icon-only, so the chip stays out of the DOM.
            if (chip.parentElement) chip.remove();
            return;
          }
          if (chip.parentElement !== row || chip.previousElementSibling !== title) {
            title.insertAdjacentElement("afterend", chip);
          }
        }
        place();
        var observer = new MutationObserver(place);
        observer.observe(row, { childList: true, subtree: true });
        return function () {
          observer.disconnect();
          chip.remove();
          chipRef.current = null;
        };
      }, []);

      React.useEffect(function () {
        var chip = chipRef.current;
        if (!chip) return;
        var dot = chip.querySelector('[data-dot]');
        var label = chip.querySelector('[data-label]');
        var phase = status && status.login ? status.login.phase : "idle";
        var paused = Boolean(status && status.paused);
        var color = "#9ca3af";
        var text = "微信";
        if (paused) {
          color = "#f59e0b";
        } else if (status && status.loggedIn) {
          color = "#22c55e";
          text = status.nick ? "微信 · " + status.nick : "微信";
        } else if (phase === "error") {
          color = "#ef4444";
        } else if (LOGIN_PHASES.indexOf(phase) >= 0) {
          color = "#f59e0b";
        }
        if (dot) dot.style.background = color;
        if (label) label.textContent = text;
        if (paused) chip.title = "微信推送已暂停，点击查看";
        else chip.title = status && status.loggedIn ? "微信已连接" : "微信未连接，点击设置";
      }, [status]);

      var close = React.useCallback(function () { setOpen(false); }, []);

      return React.createElement(
        React.Fragment,
        null,
        React.createElement("span", { ref: glyphRef, style: { display: "inline-flex", alignItems: "center" } },
          React.createElement(SuperIcon, { size: props.size })
        ),
        open ? React.createElement(WechatDialog, { initial: status, onClose: close }) : null,
        toast ? ReactDOM.createPortal(
          React.createElement(
            "div",
            {
              role: "status",
              "aria-live": "polite",
              style: {
                position: "fixed",
                right: "20px",
                bottom: "20px",
                zIndex: "9500",
                maxWidth: "320px",
                padding: "10px 12px",
                borderRadius: "9px",
                border: "1px solid rgba(245, 158, 11, 0.35)",
                background: "var(--dsh-bg-elevated, #fff)",
                color: "var(--dsh-text-primary, #111)",
                boxShadow: "0 10px 30px rgba(0, 0, 0, 0.18)",
                fontSize: "12px",
                lineHeight: "1.6"
              }
            },
            toast
          ),
          document.body
        ) : null
      );
    }

    function Launcher(props) {
      var ctx = props.ctx;
      var state = React.useState({ phase: "opening", message: "" });
      var view = state[0];
      var setView = state[1];
      var attempt = React.useState(0);
      var tick = attempt[0];
      var retry = attempt[1];

      React.useEffect(function () {
        var cancelled = false;
        setView({ phase: "opening", message: "" });
        fetch(API + "/ensure", {
          method: "POST",
          headers: { "x-dsh-super-session": "1" },
          credentials: "same-origin"
        })
          .then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (body) {
              if (!response.ok) throw new Error(body.error || "HTTP " + response.status);
              if (!body.sessionId) throw new Error("The host did not return a Super Session id");
              return body.sessionId;
            });
          })
          .then(function (sessionId) {
            return openKnown(ctx, sessionId);
          })
          .then(function () {
            if (!cancelled) setView({ phase: "opened", message: "" });
          })
          .catch(function (error) {
            if (!cancelled) setView({ phase: "error", message: String(error && error.message ? error.message : error) });
          });
        return function () { cancelled = true; };
      }, [ctx, tick]);

      var style = {
        padding: "32px",
        color: "var(--dsh-text-secondary, #666)",
        fontSize: "13px",
        lineHeight: "1.6"
      };
      if (view.phase === "error") {
        return React.createElement(
          "div",
          { style: style },
          React.createElement("div", null, "无法打开 Super Session"),
          React.createElement("div", { style: { marginTop: "8px", color: "var(--dsh-text-danger, #c33)" } }, view.message),
          React.createElement(
            "button",
            {
              type: "button",
              onClick: function () { retry(function (value) { return value + 1; }); },
              style: { marginTop: "16px", padding: "6px 12px", cursor: "pointer" }
            },
            "重试"
          )
        );
      }
      return React.createElement("div", { style: style }, "正在打开 Super Session…");
    }

    function SuperSettingsSection() {
      var state = React.useState(null);
      var settings = state[0];
      var setSettings = state[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = React.useState("");
      var error = errorState[0];
      var setError = errorState[1];

      React.useEffect(function () {
        var cancelled = false;
        api("/settings")
          .then(function (body) { if (!cancelled) setSettings(body); })
          .catch(function (failure) { if (!cancelled) setError(messageOf(failure)); });
        return function () { cancelled = true; };
      }, []);

      function toggle(next) {
        setBusy(true);
        setError("");
        api("/settings", "POST", { dispatchGuard: next })
          .then(function (body) { setSettings(body); })
          .catch(function (failure) { setError(messageOf(failure)); })
          .finally(function () { setBusy(false); });
      }

      if (!settings) {
        return React.createElement("div", { style: { padding: "24px 32px", fontSize: "13px", color: "var(--dsh-text-secondary, #666)" } },
          error ? "无法读取设置：" + error : "正在读取设置…"
        );
      }

      var enabled = settings.dispatchGuard === true;
      return React.createElement(
        "div",
        { style: { padding: "24px 32px", maxWidth: "720px", color: "var(--dsh-text-primary, #111)" } },
        React.createElement("h2", { style: { margin: "0 0 6px", fontSize: "18px", fontWeight: "600" } }, "Super Session"),
        React.createElement("p", { style: { margin: "0 0 20px", fontSize: "13px", lineHeight: "1.7", color: "var(--dsh-text-secondary, #666)" } },
          "Super Session 是一个全局唯一的会话，用来管理其他会话：转述需求、跟踪进度、总结经验。它不直接干活，除非用户明确要求。"
        ),
        React.createElement(
          "div",
          { style: { border: "1px solid var(--dsh-border, #e5e7eb)", borderRadius: "10px", padding: "16px" } },
          React.createElement(
            "label",
            { style: { display: "flex", alignItems: "flex-start", gap: "10px", cursor: busy ? "default" : "pointer" } },
            React.createElement("input", {
              type: "checkbox",
              checked: enabled,
              disabled: busy,
              onChange: function (event) { toggle(event.target.checked); },
              style: { marginTop: "3px" }
            }),
            React.createElement(
              "span",
              null,
              React.createElement("span", { style: { display: "block", fontSize: "14px", fontWeight: "600" } }, "任务转交提示"),
              React.createElement("span", { style: { display: "block", marginTop: "4px", fontSize: "12px", lineHeight: "1.7", color: "var(--dsh-text-secondary, #666)" } },
                "通过 system prompt section 给所有会话加一段通用提示：如果收到的消息与当前上下文明显对不上，先向用户确认，避免任务发错会话。默认开启。"
              ),
              React.createElement("span", { style: { display: "block", marginTop: "4px", fontSize: "12px", lineHeight: "1.7", color: "var(--dsh-text-secondary, #666)" } },
                "只影响后续组装 system prompt；不会修改 worker 的会话历史、工具或预设。"
              )
            )
          ),
          React.createElement("div", { style: { marginTop: "10px", fontSize: "12px", color: "var(--dsh-text-secondary, #666)" } },
            busy ? "正在保存…" : (enabled ? "当前：已开启" : "当前：已关闭")
          )
        ),
        error ? React.createElement("div", { style: { marginTop: "12px", fontSize: "12px", color: "var(--dsh-text-danger, #c33)" } }, error) : null
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          { name: "settings.section", id: "super-session-settings", order: 25, label: "Super Session" },
          function () { return React.createElement(SuperSettingsSection); }
        );
      });
      ctx.slots.inject("main", function () {
        return ctx.slots.register(
          { name: "main", key: PANEL_ID },
          function () { return React.createElement(Launcher, { ctx: ctx }); }
        );
      });
      ctx.slots.inject("sidebar.panellist", function () {
        return ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: 100,
            label: function () { return "Super Session"; }
          },
          function (props) {
            return React.createElement(SuperPanelEntry, { ctx: ctx, size: props && props.size });
          }
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "sessions", "uiWorkspace"];
    return module.exports;
  }
});

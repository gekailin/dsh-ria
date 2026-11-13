// dsh-ria client half: one sidebar entry that opens the single global Ria
// session as an ordinary session view, plus a small WeChat chip on that entry.
window.__ModuleLoader__.load({
  id: "dsh-ria",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var ReactDOM = require("react-dom");

    var API = "/plugins/dsh-ria/api";
    var PANEL_ID = "ria";
    // Phases that own an in-flight login flow. `waiting` is included so the
    // dialog does not restart login while a QR code is waiting to be scanned.
    var LOGIN_PHASES = ["connecting", "waiting", "scanned", "starting"];
    // Display order only. The tab that opens first comes from storage and falls
    // back to DEFAULT_CHANNEL, so moving the file-transfer helper to the end
    // does not change either behavior.
    var CHANNELS = [
      { id: "wechat-claw", name: "微信 Claw", detail: "微信机器人", hint: "使用微信扫描二维码，把机器人连接到当前微信。" },
      { id: "qq-bot", name: "QQ 机器人", detail: "QQ 开放平台", hint: "使用手机 QQ 扫描二维码，绑定 QQ 开放平台机器人。" },
      { id: "wechat", name: "微信", detail: "文件传输助手", hint: "使用微信「文件传输助手」网页版扫码登录。" }
    ];
    var DEFAULT_CHANNEL = "wechat";
    var LAST_CHANNEL_KEY = "dsh.ria.channels.last.v1";

    function isChannelId(value) {
      for (var channel = 0; channel < CHANNELS.length; channel += 1) {
        if (CHANNELS[channel].id === value) return true;
      }
      return false;
    }

    // The last opened tab is a client preference, so it lives next to the
    // shell's other dsh.*.v1 keys. Fall back to DEFAULT_CHANNEL when storage is
    // unavailable or holds a channel that no longer exists.
    function lastChannel() {
      try {
        var stored = window.localStorage.getItem(LAST_CHANNEL_KEY);
        if (stored && isChannelId(stored)) return stored;
      } catch (error) {
        // Private mode or a blocked storage partition: open the default tab.
      }
      return DEFAULT_CHANNEL;
    }

    function rememberChannel(value) {
      if (!isChannelId(value)) return;
      try {
        window.localStorage.setItem(LAST_CHANNEL_KEY, value);
      } catch (error) {
        // Remembering the tab is optional; never block the dialog on it.
      }
    }

    function RiaIcon(props) {
      var size = props && typeof props.size === "number" ? props.size : 18;
      return React.createElement(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          "aria-hidden": "true",
          style: { display: "block" }
        },
        React.createElement("path", {
          d: "m 15.11,18.49 c 0.219498,-0.01684 0.448594,-0.100251 0.62,-0.07 0.271735,-0.163642 0.570586,-0.135523 0.855468,-0.292872 0.271084,-0.0626 0.490516,-0.296276 0.735829,-0.327776 0.424457,-0.246546 0.92098,-0.58421 1.208703,-0.909352 0.496613,-0.416246 0.909174,-0.956113 1.255019,-1.508366 0.241569,-0.432313 -0.0764,0.04615 -0.174397,0.221278 C 19.473238,15.812187 19.259489,16.093324 19.11,16.21 c 0.02063,0.07256 -0.321607,0.269305 -0.400808,0.429495 -0.110125,0.169793 -0.340455,0.282633 -0.502083,0.447198 -0.232765,0.184995 -0.432875,0.371216 -0.706292,0.480817 -0.397156,0.247562 -0.249285,0.09283 0.05482,-0.07694 C 18.27482,17.078346 18.866061,16.46208 19.35,15.8 c 0.180254,-0.280846 0.419165,-0.644704 0.6,-0.97 0.251662,-0.523967 0.43648,-1.082482 0.51,-1.66 -0.113264,-0.145851 0.07024,-0.567272 -0.169116,-0.159061 -0.14793,0.176557 -0.369376,0.385458 -0.510932,0.454117 -0.186377,0.350407 -0.612677,0.550071 -0.939825,0.784344 -0.431257,0.262197 -2.26e-4,-0.04254 0.181571,-0.161312 0.276505,-0.233954 -0.269065,0.12145 -0.381698,0.181912 -0.872768,0.479675 -1.949826,0.657768 -2.912438,0.361812 0.126396,-0.03553 0.51298,0.07987 0.740645,0.0774 0.805034,0.04236 1.634172,-0.138427 2.301386,-0.606033 0.165358,-0.12052 -0.415654,0.182234 -0.535464,0.253827 -1.043846,0.474561 -2.28406,0.340943 -3.296007,-0.156451 -1.111755,-0.478405 -2.009917,-1.726286 -1.696086,-2.967553 0.190917,-0.927439 0.859145,-1.859077 1.859918,-1.9746481 0.594683,-0.095181 1.27829,0.1336436 1.558275,0.7010336 C 16.806656,10.216264 16.856391,10.517921 16.82,10.81 c 0.07388,-0.241278 0.0463,0.230907 0.0457,0.225738 -0.08274,0.20534 -0.331437,0.606109 0.0343,0.664262 0.581764,-0.04229 1.053569,-0.441901 1.46,-0.82 0.07213,-5.9e-4 0.283512,-0.384177 0.38,-0.55 C 19.344983,9.1808832 18.974976,7.7121778 18.08471,6.8191805 17.335878,6.0414145 16.236627,5.6884629 15.18,5.62 14.135072,5.5812644 13.076974,5.8506553 12.16,6.35 11.225105,6.8944871 10.433551,7.6526574 9.78,8.51 10.861134,6.8928086 12.637651,5.6922616 14.600702,5.5299122 15.119331,5.4666949 14.495122,5.4852076 14.286533,5.5211693 12.874949,5.7001219 11.543044,6.3730251 10.553204,7.3937601 9.864591,8.0283704 9.4046193,8.8524088 8.9,9.63 9.062385,9.2415033 9.3438921,8.8675488 9.56,8.49 8.5202513,9.95942 7.8559018,11.650197 6.9934354,13.223141 6.2194593,14.6257 5.4285037,16.099741 4.10295,17.062143 3.9007975,17.248721 3.5990064,17.369661 3.42,17.54 3.6379535,17.433289 4.0527925,17.242557 3.6124513,17.492529 3.3742976,17.627271 3.1243991,17.742129 2.9,17.9 c 0.089484,-0.0058 -0.1698419,0.125847 -0.071297,0.150648 -0.3076762,0.07934 -0.4433058,0.260769 -0.043101,0.141102 0.2818644,-0.08363 0.1864166,0.09023 0.5169102,-0.05208 C 3.626074,18.045361 3.957704,17.901088 4.25,17.77 3.8923137,17.965665 3.9094075,18.054343 4.269593,17.833181 4.9795066,17.454558 5.5827804,16.903129 6.12,16.31 5.734528,16.855215 5.1804495,17.250255 4.67,17.67 4.702051,17.778355 5.0759701,17.427374 5.22,17.35 6.8672085,16.110892 7.7066738,14.162934 8.6450659,12.392811 9.3529182,11.056562 9.9415469,9.6285189 10.921616,8.4610106 11.352148,7.9528725 11.864733,7.5244015 12.42,7.16 12.249944,7.2057217 11.833933,7.5325246 11.858417,7.4743888 12.964227,6.6615766 14.391997,6.1984006 15.76,6.46 16.526391,6.5966052 17.271448,6.9960489 17.782187,7.5867057 18.417532,8.4322367 18.527261,9.7487172 17.76,10.55 17.624856,10.356186 17.752209,10.019046 17.604495,9.7891744 17.304042,8.889183 16.457735,8.2191942 15.508015,8.1518837 14.995015,8.0405859 14.491641,8.2790695 14,8.31 13.868519,8.3519277 13.647931,8.5264904 13.51,8.46 13.360541,8.5851491 13.138088,8.6221206 12.93596,8.7348484 11.910463,9.2593268 11.078296,10.123121 10.592791,11.167727 10.452532,11.464102 10.28755,11.818809 10.204901,12.075889 10.162414,12.35373 10.050038,12.651126 10.02,12.91 c -0.056195,0.03375 0.04549,0.306737 -0.028306,0.477298 -0.1004969,0.168511 -0.016792,0.297056 -0.011693,0.551215 0.026072,0.144309 -0.1286725,0.392074 0.03,0.401487 0.02584,0.219373 -0.089201,0.09822 0.0224,0.489585 0.124281,0.660507 0.463105,1.320445 0.857604,1.820415 0.161189,0.191158 0.08759,0.201689 0.239558,0.28547 0.05903,0.139295 0.32031,0.41277 0.340442,0.40453 -0.36311,-0.356007 0.08226,-0.0012 0.24,0.15 0.663798,0.561007 1.50773,0.891504 2.365815,0.984273 0.327008,0.08017 0.690467,0.03366 1.034185,0.01573 z M 18.66,7.32 C 18.270298,6.6426027 17.58937,6.1468505 16.87,5.86 c 0.700866,0.3288489 1.344153,0.7951138 1.778843,1.4460536 z m -0.22,1.3 C 18.269522,8.1576595 18.118903,7.6360492 17.72471,7.2891805 17.512002,7.0633109 17.238717,6.9074175 17.01,6.7 c 0.744728,0.387975 1.272011,1.0947637 1.43,1.92 z M 18.73,8.09 C 18.693237,7.9480876 18.360621,7.3311597 18.51202,7.588318 18.576057,7.6483721 18.862057,8.2980589 18.73,8.09 Z m 0.18,1.05 c -0.011,-0.2715967 -0.06,-0.5695975 -0.09,-0.82 0.07303,0.2579108 0.125345,0.5910069 0.09,0.82 z M 14.99,9.19 C 15.14844,9.0691666 15.659446,9.1136094 15.203535,9.1637331 15.133113,9.1794829 15.061794,9.1848936 14.99,9.19 Z m 1.93,1.6 c 0.06007,-0.491244 -0.154693,-0.9702252 -0.5,-1.31 0.405605,0.3180733 0.623468,0.862913 0.5,1.37 v -0.04617 z M 14.5,17.72 C 12.919056,17.683216 11.439253,16.574246 10.953327,15.068596 10.301346,13.126207 11.10129,10.850778 12.74,9.65 c 0.05532,0.1934693 -0.258342,0.443521 -0.319701,0.673372 -0.714678,1.308185 -0.400406,3.057938 0.713438,4.043997 0.820417,0.786179 1.920729,1.234363 3.046263,1.332631 0.199466,0.137534 -0.395194,0.195548 -0.54,0.27 -0.914742,0.165208 -1.881176,-0.0284 -2.639322,-0.574198 -0.146943,-0.02802 -0.456909,-0.420306 -0.45803,-0.313154 0.249205,0.293575 0.582361,0.492836 0.897352,0.707352 -0.710788,-0.336913 -1.301877,-0.953417 -1.72,-1.63 -0.107462,-0.129576 -0.19774,-0.429074 -0.2,-0.05 0.08391,0.206406 0.03395,0.374765 0.179683,0.58661 0.113169,0.263242 0.277217,0.515329 0.460317,0.72339 -0.279533,-0.221938 0.17653,0.266269 0.29,0.34 0.917085,0.828327 2.237462,1.12355 3.432282,0.838947 0.493096,-0.10736 0.189892,0.02252 -0.129414,0.06235 -0.627093,0.118412 -1.279124,0.146437 -1.902868,-0.0013 1.053905,0.334149 2.218969,0.137265 3.213252,-0.323206 0.77602,-0.344716 1.359517,-0.978591 2.084517,-1.404481 0.349828,-0.352029 0.300263,-0.04601 0.07393,0.21931 C 19.044449,15.4196 18.860911,15.700676 18.62,15.91 c 0.191316,-0.207661 0.348723,-0.442432 0.5,-0.68 -0.557429,0.631521 -1.119533,1.278479 -1.863029,1.699804 C 16.42229,17.404501 15.471956,17.748828 14.5,17.72 Z m -1.43,-6.34 c 0.02681,-0.327862 0.156221,-0.611642 0.03736,-0.11802 -0.0027,0.04208 -0.02495,0.07867 -0.03736,0.11802 z m -0.58,1.31 c -0.20916,-0.538001 -0.195954,-1.156276 0.02,-1.69 -0.07904,0.561734 -0.129945,1.126594 -0.02,1.69 z m 0.72,-0.02 c -0.163422,-0.363864 -0.234581,-0.777423 -0.16,-1.17 -0.03506,0.397778 0.10777,0.775824 0.16,1.17 z m 2.13,2.71 c -0.772353,-0.179657 -1.529968,-0.571284 -2.05,-1.17 0.652716,0.524686 1.363538,1.001913 2.192208,1.191315 0.09971,0.04379 -0.137699,-0.02023 -0.142208,-0.02131 z m -1.97,1.08 c -0.349404,-0.18146 -0.466992,-0.194803 -0.06,0.01 0.10971,0.07536 0.298758,0.106869 0.06,-0.01 z",
          fill: "currentColor",
          fillRule: "evenodd"
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
        init.headers = { "x-dsh-ria": "1" };
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

    var knownRiaId = null;
    var riaIdRequest = null;
    var riaIdFetchedAt = 0;

    function rememberRiaId(sessionId) {
      if (sessionId) knownRiaId = String(sessionId);
    }

    function lookupRiaId() {
      if (knownRiaId) return Promise.resolve(knownRiaId);
      if (riaIdRequest && Date.now() - riaIdFetchedAt < 30000) return riaIdRequest;
      riaIdFetchedAt = Date.now();
      riaIdRequest = api("/health")
        .then(function (body) {
          if (body && body.riaSessionId) rememberRiaId(body.riaSessionId);
          return knownRiaId;
        })
        .catch(function () { return null; });
      return riaIdRequest;
    }

    function messageOf(error) {
      return String(error && error.message ? error.message : error);
    }

    // The settings shell does not expose an imperative "open section" API to
    // other client plugins: settings.launcher is single-owner and the shell
    // store stays inside ui-settings-general. Reuse the same path a person
    // takes: press the settings trigger, then click the Ria nav entry.
    function visibleElement(element) {
      return Boolean(element && element.getClientRects().length > 0);
    }

    function selectRiaSettingsSection(modal) {
      var buttons = modal.querySelectorAll("nav button");
      for (var index = 0; index < buttons.length; index += 1) {
        var button = buttons[index];
        var label = button.querySelector('[class*="navLabel"]') || button;
        if (String(label.textContent || "").trim() !== "Ria") continue;
        // The settings list can be taller than the dialog; make the target
        // visible before selecting it so the section is never off-screen.
        button.scrollIntoView({ block: "nearest" });
        if (button.getAttribute("aria-current") !== "true") button.click();
        return true;
      }
      return false;
    }

    // The settings shell has no public "open section" API. Its normal launcher
    // (button[aria-haspopup=dialog]) is replaced in this shell by the account
    // menu, so open that menu and choose its 设置 item instead.
    function settingsTrigger() {
      var candidates = Array.prototype.slice.call(document.querySelectorAll('button[aria-haspopup="dialog"]'));
      var visible = candidates.filter(visibleElement);
      var open = visible.filter(function (button) { return button.getAttribute("aria-expanded") === "true"; });
      if (open.length) return open[0];
      var named = visible.filter(function (button) {
        return /设置|settings/i.test((button.getAttribute("aria-label") || "") + " " + (button.textContent || ""));
      });
      return named[0] || null;
    }

    function accountMenuTrigger() {
      var candidates = Array.prototype.slice.call(
        document.querySelectorAll('button[aria-label="账号菜单"], button[aria-label*="账户"], button[aria-label*="账号"]')
      );
      return candidates.filter(visibleElement)[0] || null;
    }

    function settingsMenuItem() {
      var items = Array.prototype.slice.call(document.querySelectorAll('[role="menuitem"]'));
      return items.filter(function (item) {
        return visibleElement(item) && /^(设置|settings)$/i.test(String(item.textContent || "").trim());
      })[0] || null;
    }

    var settingsTimer = null;

    function openRiaSettings(onFailure) {
      if (settingsTimer) {
        clearInterval(settingsTimer);
        settingsTimer = null;
      }
      var modal = document.querySelector('[data-shortcut-modal="settings"]');
      var item = settingsMenuItem();
      var menuClicked = false;
      if (!modal && !item) {
        var trigger = settingsTrigger() || accountMenuTrigger();
        if (!trigger) {
          if (onFailure) onFailure();
          return;
        }
        trigger.click();
      } else if (!modal && item) {
        item.click();
        menuClicked = true;
      }
      var attempts = 0;
      settingsTimer = setInterval(function () {
        attempts += 1;
        var current = document.querySelector('[data-shortcut-modal="settings"]');
        if (current && selectRiaSettingsSection(current)) {
          clearInterval(settingsTimer);
          settingsTimer = null;
          return;
        }
        if (!current && !menuClicked) {
          // The account menu may render a tick after its trigger is pressed.
          var lateItem = settingsMenuItem();
          if (lateItem) {
            lateItem.click();
            menuClicked = true;
          }
        }
        if (attempts >= 75) {
          clearInterval(settingsTimer);
          settingsTimer = null;
          if (onFailure) onFailure();
        }
      }, 40);
    }

    function formatPauseTime(value) {
      if (!value) return "";
      var date = new Date(value);
      if (isNaN(date.getTime())) return String(value);
      function pad(number) { return number < 10 ? "0" + number : String(number); }
      return (date.getMonth() + 1) + "月" + date.getDate() + "日 " + pad(date.getHours()) + ":" + pad(date.getMinutes());
    }

    /* status-view:start */
    var CONNECTING_PHASES = ["connecting", "scanned", "starting"];
    var CHANNEL_COLORS = {
      offline: "#9ca3af",
      connecting: "#f59e0b",
      connected: "#22c55e",
      error: "#ef4444"
    };

    function channelPhase(channel) {
      return channel && channel.login && channel.login.phase ? channel.login.phase : "idle";
    }

    // Paused only means "connected but push is paused". A disconnected channel
    // must read as offline even if its persisted pause flag is still true.
    function channelColor(channel) {
      if (!channel) return CHANNEL_COLORS.offline;
      var phase = channelPhase(channel);
      if (phase === "error") return CHANNEL_COLORS.error;
      if (!channel.loggedIn) {
        return CONNECTING_PHASES.indexOf(phase) >= 0 ? CHANNEL_COLORS.connecting : CHANNEL_COLORS.offline;
      }
      return channel.paused ? CHANNEL_COLORS.connecting : CHANNEL_COLORS.connected;
    }

    function channelSummary(channel, fallback) {
      if (!channel) return fallback;
      var phase = channelPhase(channel);
      if (phase === "error") return "连接失败";
      if (!channel.loggedIn) {
        if (phase === "scanned") return "已扫码，待确认";
        if (phase === "connecting" || phase === "starting") return "连接中";
        return phase === "waiting" ? "未扫码" : "未连接";
      }
      return channel.paused ? "推送已暂停" : "已连接";
    }
    /* status-view:end */

    function ChannelsDialog(props) {
      var onClose = props.onClose;
      var statusState = React.useState(props.initial || null);
      var status = statusState[0];
      var setStatus = statusState[1];
      var tabState = React.useState(lastChannel);
      var tab = tabState[0];
      var setTab = tabState[1];
      var busyState = React.useState("");
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = React.useState("");
      var error = errorState[0];
      var setError = errorState[1];
      var auto = React.useRef({});

      function channels() {
        return (status && status.channels) || {};
      }

      function current() {
        return channels()[tab] || { ok: false, loggedIn: false, login: { phase: "idle", message: "" } };
      }

      React.useEffect(function () {
        var cancelled = false;
        function tick() {
          if (cancelled) return;
          api("/channels/status")
            .then(function (body) { if (!cancelled) setStatus(body); })
            .catch(function (failure) {
              if (!cancelled) setStatus({ ok: false, channels: {}, error: messageOf(failure) });
            });
        }
        tick();
        var timer = setInterval(tick, 2000);
        return function () {
          cancelled = true;
          clearInterval(timer);
        };
      }, []);

      React.useEffect(function () {
        function onKey(event) {
          if (event.key === "Escape") onClose();
        }
        window.addEventListener("keydown", onKey);
        return function () { window.removeEventListener("keydown", onKey); };
      }, [onClose]);

      function act(channelId, action, payload) {
        setBusy(channelId + ":" + action);
        setError("");
        api("/channels/" + channelId + "/" + action, "POST", payload)
          .then(function (body) {
            setStatus(function (previous) {
              var next = previous && previous.channels ? previous : { ok: true, channels: {} };
              var updated = {};
              for (var key in next.channels) updated[key] = next.channels[key];
              updated[channelId] = body;
              return { ok: true, channels: updated };
            });
          })
          .catch(function (failure) { setError(messageOf(failure)); })
          .finally(function () { setBusy(""); });
      }

      React.useEffect(function () {
        var channel = current();
        var phase = channel.login ? channel.login.phase : "idle";
        if (channel.loggedIn || LOGIN_PHASES.indexOf(phase) >= 0 || phase === "error") return;
        if (auto.current[tab]) return;
        auto.current[tab] = true;
        act(tab, "login");
      }, [status, tab]);

      var active = current();
      var login = active.login || { phase: "idle", message: "" };
      var phase = login.phase || "idle";
      var connecting = busy === tab + ":login" || phase === "connecting" || phase === "starting";
      var paused = Boolean(active.paused);
      var meta = null;
      for (var i = 0; i < CHANNELS.length; i += 1) {
        if (CHANNELS[i].id === tab) meta = CHANNELS[i];
      }
      if (!meta) {
        for (var d = 0; d < CHANNELS.length; d += 1) {
          if (CHANNELS[d].id === DEFAULT_CHANNEL) meta = CHANNELS[d];
        }
      }
      if (!meta) meta = CHANNELS[0];

      var cardStyle = {
        width: "390px",
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
      var tabRow = React.createElement(
        "div",
        { role: "tablist", style: { display: "flex", gap: "6px", marginTop: "14px", marginBottom: "14px" } },
        CHANNELS.map(function (channel) {
          var value = channels()[channel.id] || {};
          var selected = channel.id === tab;
          return React.createElement(
            "button",
            {
              key: channel.id,
              type: "button",
              role: "tab",
              "aria-selected": selected ? "true" : "false",
              onClick: function () {
                setTab(channel.id);
                rememberChannel(channel.id);
                setError("");
              },
              style: {
                flex: "1",
                minWidth: "0",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "5px",
                padding: "7px 6px",
                borderRadius: "8px",
                border: selected ? "1px solid var(--dsh-accent, #3b82f6)" : "1px solid var(--dsh-border, #e5e7eb)",
                background: selected ? "rgba(59, 130, 246, 0.08)" : "transparent",
                color: "inherit",
                cursor: "pointer",
                fontSize: "11px",
                lineHeight: "1.2",
                whiteSpace: "nowrap"
              }
            },
            React.createElement("span", {
              style: { width: "6px", height: "6px", borderRadius: "50%", background: channelColor(value), flex: "0 0 auto" }
            }),
            channel.name
          );
        })
      );

      var panel;
      if (active.loggedIn) {
        var pauseAt = active.pausedAt ? formatPauseTime(active.pausedAt) : "";
        panel = React.createElement(
          "div",
          null,
          React.createElement("div", { style: { fontSize: "13px", lineHeight: "1.7" } },
            "已连接：",
            React.createElement("strong", null, active.nick || active.accountId || active.user || "当前账号")
          ),
          React.createElement(
            "div",
            {
              role: "status",
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
                  background: paused ? "#f59e0b" : "#22c55e",
                  boxShadow: paused ? "0 0 0 3px rgba(245, 158, 11, 0.16)" : "0 0 0 3px rgba(34, 197, 94, 0.14)",
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
                  paused ? "来源：" + (active.pausedBy === "manual" ? "手动" : "自动" + (active.pauseReason ? "（" + active.pauseReason + "）" : "")) + (pauseAt ? " · 暂停于 " + pauseAt : "") : "Ria 的回复会同步到" + meta.name + "。"
                )
              ),
              React.createElement("button", {
                type: "button",
                disabled: Boolean(busy),
                title: paused ? "恢复" + meta.name + "推送" : "暂停" + meta.name + "推送",
                style: { padding: "6px 11px", borderRadius: "7px", border: "1px solid var(--dsh-border, #d1d5db)", background: "transparent", color: "inherit", cursor: busy ? "default" : "pointer", fontSize: "12px", whiteSpace: "nowrap", flex: "0 0 auto" },
                onClick: function () { act(tab, "pause", paused ? { paused: false } : { paused: true, reason: "用户手动暂停推送" }); }
              }, busy ? "正在保存…" : (paused ? "恢复推送" : "暂停推送"))
            ),
            paused ? React.createElement("div", { style: { marginTop: "8px", fontSize: "11px", lineHeight: "1.6", color: "var(--dsh-text-secondary, #666)" } },
              "只停出站推送；连接和入站消息不受影响。"
            ) : null
          ),
          active.error ? React.createElement("div", { style: { marginTop: "10px", fontSize: "12px", lineHeight: 1.6, color: "#ef4444" } }, "通道错误：" + active.error) : null,
          React.createElement("div", { style: { marginTop: "16px", display: "flex", justifyContent: "flex-end", gap: "8px" } },
            React.createElement("button", {
              type: "button",
              disabled: Boolean(busy),
              style: buttonStyle,
              onClick: function () { act(tab, "logout"); }
            }, busy === tab + ":logout" ? "正在退出…" : "退出登录")
          )
        );
      } else {
        panel = React.createElement(
          "div",
          null,
          login.qr ? React.createElement("div", { style: { marginTop: "4px", textAlign: "center" } },
            React.createElement("img", {
              src: login.qr,
              alt: meta.name + "登录二维码",
              width: 210,
              height: 210,
              style: { width: "210px", height: "210px", background: "#fff", borderRadius: "8px" }
            })
          ) : null,
          React.createElement("div", { style: { marginTop: "12px", fontSize: "13px", lineHeight: "1.6", textAlign: "center" } },
            connecting ? "正在连接" + meta.name + "…" : (login.message || "尚未连接" + meta.name)
          ),
          phase === "scanned" ? React.createElement("div", { style: { marginTop: "4px", fontSize: "12px", color: "#f59e0b", textAlign: "center" } }, "已扫码，请在手机上确认") : null,
          error ? React.createElement("div", { style: { marginTop: "10px", fontSize: "12px", color: "#ef4444", lineHeight: "1.6" } }, error) : null,
          React.createElement("div", { style: { marginTop: "16px", display: "flex", justifyContent: "center", gap: "8px" } },
            React.createElement("button", {
              type: "button",
              disabled: Boolean(busy),
              style: buttonStyle,
              onClick: function () { act(tab, "login"); }
            }, busy === tab + ":login" ? "正在获取…" : (login.qr ? "刷新二维码" : "连接" + meta.name))
          ),
          React.createElement("div", { style: { marginTop: "12px", fontSize: "11px", lineHeight: "1.7", color: "var(--dsh-text-secondary, #888)", textAlign: "center" } },
            meta.hint
          )
        );
      }

      return ReactDOM.createPortal(
        React.createElement(
          "div",
          {
            role: "presentation",
            onClick: function (event) {
              // The portal lives under the Ria entry button in the React tree,
              // so an un-stopped click would also activate that host row and
              // remount the conversation behind the dialog. Keep clicks local
              // to the overlay: backdrop clicks still close, but never bubble.
              event.stopPropagation();
              if (event.target === event.currentTarget) onClose();
            },
            onMouseDown: function (event) { event.stopPropagation(); },
            onPointerDown: function (event) { event.stopPropagation(); },
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
            { role: "dialog", "aria-modal": "true", "aria-label": "聊天连接", style: cardStyle },
            React.createElement(
              "div",
              { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" } },
              React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "15px", fontWeight: "600" } },
                React.createElement("span", { style: { width: "8px", height: "8px", borderRadius: "50%", background: channelColor(active), display: "inline-block" } }),
                "聊天连接"
              ),
              React.createElement("button", {
                type: "button",
                "aria-label": "关闭",
                onClick: onClose,
                style: { border: "0", background: "transparent", color: "inherit", fontSize: "18px", cursor: "pointer", lineHeight: "1" }
              }, "×")
            ),
            tabRow,
            panel,
            React.createElement("div", { style: { marginTop: "16px", paddingTop: "12px", borderTop: "1px solid var(--dsh-border, #e5e7eb)", fontSize: "11px", lineHeight: "1.6", color: "var(--dsh-text-secondary, #888)" } },
              "扫码后凭据保存在本机 DSH_HOME/state/ria/ 下。Ria 会回复最后收到消息的通道；其他通道自动暂停，避免重复推送。"
            )
          )
        ),
        document.body
      );
    }

    function RiaPanelEntry(props) {
      var ctx = props.ctx;
      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var boardOpenState = React.useState(false);
      var boardOpen = boardOpenState[0];
      var setBoardOpen = boardOpenState[1];
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
        var wechat = body && body.channels ? body.channels.wechat : null;
        var paused = Boolean(wechat && wechat.paused);
        var wasPaused = lastPaused.current;
        var known = primed.current;
        lastPaused.current = paused;
        primed.current = true;
        if (known && !wasPaused && paused && wechat && wechat.pausedBy === "channel") {
          setToast("已自动暂停微信推送" + (wechat.pauseReason ? "：" + wechat.pauseReason : ""));
          if (toastTimer.current) clearTimeout(toastTimer.current);
          toastTimer.current = setTimeout(function () { setToast(""); }, 8000);
        }
      }

      React.useEffect(function () {
        var cancelled = false;
        function tick() {
          if (cancelled || document.hidden) return;
          api("/channels/status")
            .then(function (body) { if (!cancelled) applyStatus(body); })
            .catch(function () { if (!cancelled) setStatus({ ok: false, channels: {}, error: "无法获取连接状态" }); });
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

        var chipGroup = document.createElement("span");
        chipGroup.setAttribute("data-ria-chip-group", "1");
        chipGroup.style.cssText = "display:inline-flex;align-items:center;gap:6px;margin-left:auto;flex:0 0 auto;min-width:0;";

        var boardChip = document.createElement("span");
        boardChip.setAttribute("role", "button");
        boardChip.setAttribute("tabindex", "0");
        boardChip.setAttribute("aria-label", "打开任务看板");
        boardChip.title = "任务看板";
        boardChip.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;padding:0;margin-left:0;border:1px solid var(--dsh-border, #d1d5db);border-radius:999px;color:var(--dsh-text-secondary, #666);cursor:pointer;flex:0 0 auto;background:transparent;box-sizing:border-box;";
        var boardGlyph = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        boardGlyph.setAttribute("width", "12");
        boardGlyph.setAttribute("height", "12");
        boardGlyph.setAttribute("viewBox", "0 0 24 24");
        boardGlyph.setAttribute("fill", "none");
        boardGlyph.setAttribute("stroke", "currentColor");
        boardGlyph.setAttribute("stroke-width", "2");
        boardGlyph.setAttribute("stroke-linecap", "round");
        boardGlyph.setAttribute("stroke-linejoin", "round");
        boardGlyph.setAttribute("aria-hidden", "true");
        ["M4 4h16v16H4z", "M9 4v16", "M15 4v16", "M4 9h16"].forEach(function (d) {
          var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", d);
          boardGlyph.appendChild(path);
        });
        boardChip.appendChild(boardGlyph);
        function hoverBoard(on) {
          boardChip.style.background = on ? "rgba(148, 163, 184, 0.18)" : "transparent";
        }
        boardChip.addEventListener("mouseenter", function () { hoverBoard(true); });
        boardChip.addEventListener("mouseleave", function () { hoverBoard(false); });
        function openBoard(event) {
          event.preventDefault();
          event.stopPropagation();
          setBoardOpen(true);
        }
        boardChip.addEventListener("click", openBoard);
        boardChip.addEventListener("keydown", function (event) {
          if (event.key === "Enter" || event.key === " ") openBoard(event);
        });

        var settingsChip = document.createElement("span");
        settingsChip.setAttribute("role", "button");
        settingsChip.setAttribute("tabindex", "0");
        settingsChip.setAttribute("aria-label", "打开 Ria 设置");
        settingsChip.title = "Ria 设置";
        settingsChip.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;padding:0;margin-left:0;border:1px solid var(--dsh-border, #d1d5db);border-radius:999px;color:var(--dsh-text-secondary, #666);cursor:pointer;flex:0 0 auto;background:transparent;box-sizing:border-box;";
        var gear = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        gear.setAttribute("width", "12");
        gear.setAttribute("height", "12");
        gear.setAttribute("viewBox", "0 0 24 24");
        gear.setAttribute("fill", "none");
        gear.setAttribute("stroke", "currentColor");
        gear.setAttribute("stroke-width", "2");
        gear.setAttribute("stroke-linecap", "round");
        gear.setAttribute("aria-hidden", "true");
        var gearPaths = ["M4 7h9", "M17 7h3", "M4 17h3", "M11 17h9"];
        for (var gearIndex = 0; gearIndex < gearPaths.length; gearIndex += 1) {
          var gearPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
          gearPath.setAttribute("d", gearPaths[gearIndex]);
          gear.appendChild(gearPath);
        }
        var gearKnobTop = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        gearKnobTop.setAttribute("cx", "15");
        gearKnobTop.setAttribute("cy", "7");
        gearKnobTop.setAttribute("r", "2");
        gear.appendChild(gearKnobTop);
        var gearKnobBottom = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        gearKnobBottom.setAttribute("cx", "9");
        gearKnobBottom.setAttribute("cy", "17");
        gearKnobBottom.setAttribute("r", "2");
        gear.appendChild(gearKnobBottom);
        settingsChip.appendChild(gear);
        function hoverSettings(on) {
          settingsChip.style.background = on ? "rgba(148, 163, 184, 0.18)" : "transparent";
        }
        settingsChip.addEventListener("mouseenter", function () { hoverSettings(true); });
        settingsChip.addEventListener("mouseleave", function () { hoverSettings(false); });
        function openSettings(event) {
          event.preventDefault();
          event.stopPropagation();
          openRiaSettings(function () {
            setToast("无法打开设置面板，请从账号菜单 → 设置进入");
            if (toastTimer.current) clearTimeout(toastTimer.current);
            toastTimer.current = setTimeout(function () { setToast(""); }, 8000);
          });
        }
        settingsChip.addEventListener("click", openSettings);
        settingsChip.addEventListener("keydown", function (event) {
          if (event.key === "Enter" || event.key === " ") openSettings(event);
        });

        var chip = document.createElement("span");
        chip.setAttribute("role", "button");
        chip.setAttribute("tabindex", "0");
        chip.setAttribute("aria-label", "聊天连接");
        chip.style.cssText = "display:inline-flex;align-items:center;gap:4px;height:19px;padding:0 6px;margin-left:0;border:1px solid var(--dsh-border, #d1d5db);border-radius:999px;font-size:10px;line-height:1;color:var(--dsh-text-secondary, #666);cursor:pointer;flex:0 0 auto;background:transparent;";
        var dots = document.createElement("span");
        dots.style.cssText = "display:inline-flex;align-items:center;gap:2px;";
        for (var index = 0; index < CHANNELS.length; index += 1) {
          var dot = document.createElement("span");
          dot.setAttribute("data-dot", CHANNELS[index].id);
          dot.style.cssText = "width:5px;height:5px;border-radius:50%;background:#9ca3af;display:inline-block;";
          dots.appendChild(dot);
        }
        var label = document.createElement("span");
        label.setAttribute("data-label", "1");
        label.textContent = "连接";
        chip.appendChild(dots);
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
            // Collapsed sidebar: the row is only 36px wide, so the chip group
            // cannot fit. Keep the icon-only entry clean; the chips return as
            // soon as the sidebar expands.
            chipGroup.remove();
            return;
          }
          if (chipGroup.parentElement !== row) row.appendChild(chipGroup);
          if (
            boardChip.parentElement !== chipGroup ||
            boardChip.nextElementSibling !== settingsChip ||
            settingsChip.nextElementSibling !== chip
          ) {
            chipGroup.replaceChildren(boardChip, settingsChip, chip);
          }
        }
        place();
        var observer = new MutationObserver(place);
        observer.observe(row, { childList: true, subtree: true });
        return function () {
          observer.disconnect();
          chipGroup.remove();
          chipRef.current = null;
        };
      }, []);

      React.useEffect(function () {
        var chip = chipRef.current;
        if (!chip) return;
        var all = (status && status.channels) || {};
        var connected = 0;
        var totals = [];
        for (var index = 0; index < CHANNELS.length; index += 1) {
          var channel = all[CHANNELS[index].id];
          var dot = chip.querySelector('[data-dot="' + CHANNELS[index].id + '"]');
          if (dot) dot.style.background = channelColor(channel);
          if (channel && channel.loggedIn) connected += 1;
          totals.push(CHANNELS[index].name + "：" + channelSummary(channel, "未连接"));
        }
        var label = chip.querySelector('[data-label]');
        if (label) label.textContent = connected ? "连接 " + connected : "连接";
        chip.title = totals.join(" · ") + "（点击管理）";
      }, [status]);

      var close = React.useCallback(function () { setOpen(false); }, []);

      return React.createElement(
        React.Fragment,
        null,
        React.createElement("span", { ref: glyphRef, style: { display: "inline-flex", alignItems: "center" } },
          React.createElement(RiaIcon, { size: props.size })
        ),
        open ? React.createElement(ChannelsDialog, { initial: status, onClose: close }) : null,
        boardOpen ? React.createElement(BoardOverlay, { open: boardOpen, onClose: function () { setBoardOpen(false); } }) : null,
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
          headers: { "x-dsh-ria": "1" },
          credentials: "same-origin"
        })
          .then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (body) {
              if (!response.ok) throw new Error(body.error || "HTTP " + response.status);
              if (!body.sessionId) throw new Error("The host did not return a Ria session id");
              return body.sessionId;
            });
          })
          .then(function (sessionId) {
            rememberRiaId(sessionId);
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
          React.createElement("div", null, "无法打开 Ria"),
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
      return React.createElement("div", { style: style }, "正在打开 Ria…");
    }

    function RiaSettingsSection() {
      var state = React.useState(null);
      var settings = state[0];
      var setSettings = state[1];
      var busyState = React.useState("");
      var busyKey = busyState[0];
      var setBusyKey = busyState[1];
      var busy = busyKey !== "";
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

      function save(key, patch) {
        setBusyKey(key);
        setError("");
        api("/settings", "POST", patch)
          .then(function (body) { setSettings(body); })
          .catch(function (failure) { setError(messageOf(failure)); })
          .finally(function () { setBusyKey(""); });
      }

      // 0.6-alpha card: the blur keeps the page readable when a dark or busy
      // wallpaper sits behind it. Text colours are deliberately one step darker
      // than the old opaque card so every label still clears 4.5:1 on the
      // worst-case (near-black) composited background.
      var cardStyle = {
        background: "rgba(255, 255, 255, 0.6)",
        backdropFilter: "blur(28px) saturate(1.25) brightness(1.12)",
        WebkitBackdropFilter: "blur(28px) saturate(1.25) brightness(1.12)",
        border: "1px solid rgba(100, 116, 139, 0.35)",
        borderRadius: "12px",
        padding: "20px 22px",
        boxSizing: "border-box",
        color: "#0f172a",
        boxShadow: "0 10px 30px rgba(15, 23, 42, 0.08)"
      };
      var titleStyle = { margin: "0 0 6px", fontSize: "18px", fontWeight: "600", color: "#0f172a" };
      var introStyle = { margin: "0", fontSize: "13px", lineHeight: "1.7", color: "#1f2937" };
      var rowStyle = { borderTop: "1px solid rgba(100, 116, 139, 0.28)", marginTop: "16px", paddingTop: "16px" };
      var rowTitleStyle = { display: "block", fontSize: "14px", fontWeight: "600", color: "#0f172a" };
      var noteStyle = { display: "block", marginTop: "4px", fontSize: "12px", lineHeight: "1.7", color: "#1f2937" };
      var statusStyle = { marginTop: "10px", fontSize: "12px", lineHeight: "1.7", color: "#1f2937" };
      var errorStyle = { marginTop: "14px", fontSize: "12px", lineHeight: "1.7", color: "#b91c1c" };

      if (!settings) {
        return React.createElement(
          "div",
          { style: { padding: "24px 32px", maxWidth: "720px", boxSizing: "border-box" } },
          React.createElement(
            "div",
            { style: cardStyle },
            React.createElement("h2", { style: titleStyle }, "Ria"),
            React.createElement("p", { style: error ? { margin: "0", fontSize: "13px", lineHeight: "1.7", color: "#b91c1c" } : introStyle },
              error ? "无法读取设置：" + error : "正在读取设置…"
            )
          )
        );
      }

      var dispatchEnabled = settings.dispatchGuard === true;
      var autoPauseEnabled = settings.wechatAutoPause === true;
      return React.createElement(
        "div",
        { style: { padding: "24px 32px", maxWidth: "720px", boxSizing: "border-box" } },
        React.createElement(
          "div",
          { style: cardStyle },
          React.createElement("h2", { style: titleStyle }, "Ria"),
          React.createElement("p", { style: introStyle },
            "Ria 是一个全局唯一的会话，用来管理其他会话：转述需求、跟踪进度、总结经验。它不直接干活，除非用户明确要求。"
          ),
          React.createElement(
            "div",
            { style: rowStyle },
            React.createElement(
              "label",
              { style: { display: "flex", alignItems: "flex-start", gap: "10px", cursor: busy ? "default" : "pointer" } },
              React.createElement("input", {
                type: "checkbox",
                checked: dispatchEnabled,
                disabled: busy,
                onChange: function (event) { save("dispatch", { dispatchGuard: event.target.checked }); },
                style: { marginTop: "3px", width: "16px", height: "16px", accentColor: "#0f766e" }
              }),
              React.createElement(
                "span",
                null,
                React.createElement("span", { style: rowTitleStyle }, "任务转交提示"),
                React.createElement("span", { style: noteStyle },
                  "通过 system prompt section 给所有会话加一段通用提示：如果收到的消息与当前上下文明显对不上，先向用户确认，避免任务发错会话。默认开启。"
                ),
                React.createElement("span", { style: noteStyle },
                  "只影响后续组装 system prompt；不会修改 worker 的会话历史、工具或预设。"
                )
              )
            ),
            React.createElement("div", { style: statusStyle },
              busyKey === "dispatch" ? "正在保存…" : (dispatchEnabled ? "当前：已开启" : "当前：已关闭")
            )
          ),
          React.createElement(
            "div",
            { style: rowStyle },
            React.createElement(
              "label",
              { style: { display: "flex", alignItems: "flex-start", gap: "10px", cursor: busy ? "default" : "pointer" } },
              React.createElement("input", {
                type: "checkbox",
                checked: autoPauseEnabled,
                disabled: busy,
                onChange: function (event) { save("autoPause", { wechatAutoPause: event.target.checked }); },
                style: { marginTop: "3px", width: "16px", height: "16px", accentColor: "#0f766e" }
              }),
              React.createElement(
                "span",
                null,
                React.createElement("span", { style: rowTitleStyle }, "自动暂停微信推送"),
                React.createElement("span", { style: noteStyle },
                  "微信「文件传输助手」之外的通道（含微信 Claw、QQ）发来消息时，自动暂停「文件传输助手」推送，避免把别的会话内容误发到微信。默认开启。"
                ),
                React.createElement("span", { style: noteStyle },
                  "暂停期间「文件传输助手」不再推送，回一条「文件传输助手」消息会自动恢复；手动暂停/恢复不受影响。微信 Claw 和 QQ 仍按“最后消息通道”规则各自暂停。"
                ),
                autoPauseEnabled ? null : React.createElement("span", { style: noteStyle },
                  "关闭只关闭「文件传输助手」的自动暂停，不影响 Claw/QQ 的规则，也不会自动恢复当前已暂停的推送。"
                )
              )
            ),
            React.createElement("div", { style: statusStyle },
              busyKey === "autoPause" ? "正在保存…" : (autoPauseEnabled ? "当前：已开启" : "当前：已关闭")
            )
          ),
          error ? React.createElement("div", { style: errorStyle }, error) : null
        )
      );
    }

    function DispatchNoteCard(props) {
      var sessionId = props && props.sessionId ? String(props.sessionId) : "";
      var turn = props && props.turn && Number.isSafeInteger(props.turn.turn) ? props.turn.turn : undefined;
      var state = React.useState([]);
      var notes = state[0];
      var setNotes = state[1];

      React.useEffect(function () {
        var cancelled = false;
        if (!sessionId || turn === undefined) {
          setNotes([]);
          return function () { cancelled = true; };
        }
        setNotes([]);
        lookupRiaId()
          .then(function (riaId) {
            if (cancelled || !riaId || riaId !== sessionId) return;
            return api("/dispatch-notes?sessionId=" + encodeURIComponent(sessionId) + "&turn=" + turn)
              .then(function (body) {
                if (cancelled) return;
                var list = body && Array.isArray(body.notes) ? body.notes : [];
                setNotes(list.filter(function (note) { return note && note.turn === turn; }));
              })
              .catch(function () {
                if (!cancelled) setNotes([]);
              });
          })
          .catch(function () {
            if (!cancelled) setNotes([]);
          });
        return function () { cancelled = true; };
      }, [sessionId, turn]);

      if (!notes.length) return null;
      return React.createElement(
        React.Fragment,
        null,
        notes.map(function (note) {
          var approval = note.kind === "approval";
          return React.createElement(
            "div",
            {
              key: note.noteId,
              "data-ria-dispatch-note": approval ? "approval" : (note.isTicket ? "ticket" : "relay"),
              style: {
                margin: "10px 0 4px",
                padding: "10px 12px",
                border: "1px solid var(--dsh-border, #e5e7eb)",
                borderLeft: "3px solid " + (approval ? "#f59e0b" : "#3b82f6"),
                borderRadius: "8px",
                background: "var(--dsh-bg-elevated, #fff)",
                color: "var(--dsh-text-primary, #111)",
                fontSize: "13px",
                lineHeight: "1.65"
              }
            },
            React.createElement(
              "div",
              { style: { marginBottom: "4px", fontSize: "12px", fontWeight: "600", color: approval ? "#b45309" : "#2563eb" } },
              approval ? "等待权限审批" : (note.isTask ? "任务已派发" : "消息已转交")
            ),
            React.createElement(
              "div",
              { style: { whiteSpace: "pre-wrap", wordBreak: "break-word" } },
              note.note
            )
          );
        })
      );
    }

    // Shown above Ria's composer while the session is still blank. The welcome
    // used to be a synthetic turn written into the session log, but a stored
    // session whose first surface node is an assistant message fails the v4
    // format check ("system/message requires a protected first surface head"),
    // so the greeting lives in the client and never touches the log.
    function WelcomeCard(props) {
      var sessionId = props && props.sessionId ? String(props.sessionId) : "";
      var sessions = props && props.sessions;
      var state = React.useState(false);
      var visible = state[0];
      var setVisible = state[1];

      React.useEffect(function () {
        var cancelled = false;
        var unsubscribe = null;
        function read() {
          var blank = false;
          try {
            var snap = sessions && sessions.list && typeof sessions.list.getSnapshot === "function" ? sessions.list.getSnapshot() : undefined;
            var entry = snap && snap.byId ? snap.byId[sessionId] : undefined;
            blank = !!(entry && entry.blank === true);
          } catch (_error) {
            blank = false;
          }
          if (!cancelled) setVisible(blank);
        }
        setVisible(false);
        lookupRiaId()
          .then(function (riaId) {
            if (cancelled || !riaId || riaId !== sessionId) return;
            read();
            if (sessions && sessions.list && typeof sessions.list.subscribe === "function") {
              unsubscribe = sessions.list.subscribe(read);
            }
          })
          .catch(function () {
            if (!cancelled) setVisible(false);
          });
        return function () {
          cancelled = true;
          if (unsubscribe) unsubscribe();
        };
      }, [sessionId]);

      if (!visible) return null;
      return React.createElement(
        "div",
        {
          "data-ria-welcome": "",
          style: {
            margin: "0 0 8px",
            padding: "12px 14px",
            border: "1px solid var(--dsh-border, #e5e7eb)",
            borderLeft: "3px solid #0ea5e9",
            borderRadius: "8px",
            background: "var(--dsh-bg-elevated, #fff)",
            color: "var(--dsh-text-primary, #111)",
            fontSize: "13px",
            lineHeight: "1.7"
          }
        },
        React.createElement("div", { style: { marginBottom: "6px", fontSize: "14px", fontWeight: "600" } }, "欢迎使用 Ria。"),
        React.createElement("div", null, "我是你的会话管家：把目标告诉我，我负责澄清需求、转交给合适的 worker session，并跟踪结果。"),
        React.createElement(
          "ul",
          { style: { margin: "6px 0 0", paddingLeft: "18px" } },
          React.createElement("li", null, "在下方选择模型，Ria 需要模型才能工作。"),
          React.createElement("li", null, "建议把权限设为最高（danger-full-access）并设置审批策略；否则敏感操作可能被拦截。"),
          React.createElement("li", null, "直接告诉我你想做什么，我会先问清关键细节再下发。")
        )
      );
    }


    // Read-only ticket board. The server projects tickets plus session/workspace
    // metadata; this view only lays them out: lanes on the vertical axis, six
    // quantile time buckets on the horizontal one, and one SVG layer for edges.
    var BOARD_STATUS = {
      intake: { label: "待整理", color: "#64748b" },
      open: { label: "待派发", color: "#2563eb" },
      working: { label: "进行中", color: "#d97706" },
      blocked: { label: "阻塞", color: "#dc2626" },
      done: { label: "完成", color: "#16a34a" },
      cancelled: { label: "取消", color: "#94a3b8" },
      forked: { label: "已分叉", color: "#7c3aed" }
    };
    var BOARD_TERMINAL = { done: true, cancelled: true, forked: true };
    var BOARD_BUCKETS = 6;

    function boardStatus(status) {
      return BOARD_STATUS[status] || { label: String(status || ""), color: "#64748b" };
    }

    function shortSessionId(sessionId) {
      var raw = String(sessionId || "");
      var tail = raw.replace(/^session-/, "");
      return tail.length > 8 ? tail.slice(0, 8) : tail;
    }

    function boardDate(timestamp) {
      if (!Number.isFinite(timestamp)) return "—";
      var date = new Date(timestamp);
      return String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
    }

    // Quantile buckets rather than equal wall-clock slices: a long tail of
    // tickets made on the same day would otherwise pile into one column.
    function boardTimeTicks(tickets) {
      var sorted = tickets.slice().sort(function (left, right) {
        return (left.createdAt || 0) - (right.createdAt || 0);
      });
      var total = sorted.length;
      var positions = new Map();
      sorted.forEach(function (ticket, index) {
        positions.set(ticket.ticketId, total ? Math.min(BOARD_BUCKETS - 1, Math.floor((index * BOARD_BUCKETS) / total)) : 0);
      });
      var buckets = [];
      for (var index = 0; index < BOARD_BUCKETS; index += 1) {
        var first = sorted[Math.floor((index * total) / BOARD_BUCKETS)];
        var last = sorted[Math.max(0, Math.floor(((index + 1) * total) / BOARD_BUCKETS) - 1)] || first;
        var start = first ? first.createdAt : NaN;
        var end = last ? last.createdAt : start;
        buckets.push({
          label: Number.isFinite(start) ? boardDate(start) + (boardDate(start) === boardDate(end) ? "" : "–" + boardDate(end)) + " · " + (index + 1) + "/6" : "—"
        });
      }
      return { positions: positions, buckets: buckets };
    }

    function boardBucket(ticket, time) {
      var index = time.positions.get(ticket.ticketId);
      return Number.isFinite(index) ? index : 0;
    }

    function BoardCard(props) {
      var ticket = props.ticket;
      var meta = boardStatus(ticket.status);
      var dependencies = Array.isArray(ticket.dependsOn) ? ticket.dependsOn.length : 0;
      var queue = ticket.queueText && ticket.queueState !== "ready" ? ticket.queueText : "";
      var worker = ticket.executorTitle || (ticket.executorMissing ? "worker 已删除" : "未分配");
      var workerCode = ticket.executor && ticket.executor !== "self" && ticket.executor !== "ria" ? shortSessionId(ticket.executor) : "";
      var progress = typeof ticket.progress === "string" ? ticket.progress : "";
      var flags = [];
      if (ticket.executorArchived) flags.push("已归档");
      if (ticket.executorMissing) flags.push("worker 缺失");
      // Settled tickets collapse to two lines: a long lane full of finished
      // work should read as history, not push the active lanes off screen.
      var compact = !!BOARD_TERMINAL[ticket.status];
      return React.createElement(
        "div",
        {
          "data-ria-card": ticket.ticketId,
          "data-ria-status": ticket.status,
          title: ticket.goal,
          onMouseEnter: function () { props.onHover(ticket.ticketId); },
          onMouseLeave: function () { props.onHover(null); },
          style: {
            position: "relative",
            zIndex: 2,
            margin: compact ? "0 0 4px" : "0 0 7px",
            padding: compact ? "4px 7px 4px" : "8px 9px 7px",
            border: "1px solid #e2e8f0",
            borderLeft: "3px solid " + meta.color,
            borderRadius: "7px",
            background: "#ffffff",
            boxShadow: "0 1px 2px rgba(15, 23, 42, 0.07)",
            opacity: props.dimmed ? 0.22 : 1,
            transition: "opacity 120ms ease"
          }
        },
        React.createElement(
          "div",
          {
            style: {
              fontSize: compact ? "11.5px" : "12px",
              lineHeight: compact ? "1.35" : "1.45",
              color: "#0f172a",
              fontWeight: "600",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap"
            }
          },
          ticket.goal
        ),
        React.createElement(
          "div",
          { style: { marginTop: compact ? "2px" : "4px", display: "flex", alignItems: "center", gap: "5px", flexWrap: "wrap", fontSize: compact ? "9.5px" : "10.5px", color: "#475569" } },
          React.createElement("span", { style: { color: meta.color, fontWeight: "700" } }, meta.label),
          progress ? React.createElement("span", { style: { color: "#64748b" } }, "清单 " + progress) : null,
          React.createElement("span", { style: { color: "#94a3b8" } }, shortSessionId(ticket.ticketId)),
          React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "118px" } }, worker),
          workerCode ? React.createElement("span", { style: { color: "#94a3b8" } }, workerCode) : null
        ),
        !compact && (queue || dependencies) ? React.createElement(
          "div",
          { style: { marginTop: "3px", fontSize: "10.5px", color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
          queue ? queue : "依赖 " + dependencies
        ) : null,
        !compact && flags.length ? React.createElement(
          "div",
          { style: { marginTop: "3px", fontSize: "10.5px", color: "#b45309" } },
          flags.join(" · ")
        ) : null
      );
    }

    function BoardOverlay(props) {
      var open = props.open;
      var onClose = props.onClose;
      var state = React.useState(null);
      var board = state[0];
      var setBoard = state[1];
      var loadingState = React.useState(false);
      var loading = loadingState[0];
      var setLoading = loadingState[1];
      var errorState = React.useState("");
      var error = errorState[0];
      var setError = errorState[1];
      var filterState = React.useState("all");
      var filter = filterState[0];
      var setFilter = filterState[1];
      var focusState = React.useState(null);
      var focus = focusState[0];
      var setFocus = focusState[1];
      var hoverState = React.useState(null);
      var hover = hoverState[0];
      var setHover = hoverState[1];
      var edgeState = React.useState([]);
      var edges = edgeState[0];
      var setEdges = edgeState[1];
      var sizeState = React.useState({ width: 0, height: 0 });
      var size = sizeState[0];
      var setSize = sizeState[1];
      var timingState = React.useState(0);
      var timing = timingState[0];
      var setTiming = timingState[1];
      var revisionState = React.useState(0);
      var revision = revisionState[0];
      var setRevision = revisionState[1];
      var gridRef = React.useRef(null);
      var scrollRef = React.useRef(null);

      React.useEffect(function () {
        if (!open) return;
        var cancelled = false;
        var started = performance.now();
        setLoading(true);
        setError("");
        setFocus(null);
        setHover(null);
        api("/board")
          .then(function (body) {
            if (cancelled) return;
            setBoard(body);
            setTiming(performance.now() - started);
          })
          .catch(function (failure) {
            if (!cancelled) setError(messageOf(failure));
          })
          .finally(function () {
            if (!cancelled) setLoading(false);
          });
        return function () { cancelled = true; };
      }, [open]);

      React.useEffect(function () {
        if (!open) return;
        function close(event) {
          if (event && event.key === "Escape") onClose();
        }
        window.addEventListener("keydown", close);
        return function () { window.removeEventListener("keydown", close); };
      }, [open, onClose]);

      React.useEffect(function () {
        if (!open) return;
        var target = gridRef.current;
        if (!target) return;
        var frame = 0;
        function schedule() {
          if (frame) cancelAnimationFrame(frame);
          frame = requestAnimationFrame(function () {
            frame = 0;
            setRevision(function (value) { return value + 1; });
          });
        }
        var observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
        if (observer) observer.observe(target);
        window.addEventListener("resize", schedule);
        return function () {
          if (frame) cancelAnimationFrame(frame);
          if (observer) observer.disconnect();
          window.removeEventListener("resize", schedule);
        };
      }, [open, board, filter]);

      React.useLayoutEffect(function () {
        if (!open) return;
        var grid = gridRef.current;
        if (!grid) return;
        var gridBox = grid.getBoundingClientRect();
        var cards = new Map();
        Array.prototype.forEach.call(grid.querySelectorAll("[data-ria-card]"), function (node) {
          var box = node.getBoundingClientRect();
          cards.set(node.getAttribute("data-ria-card"), {
            left: box.left - gridBox.left,
            right: box.right - gridBox.left,
            top: box.top - gridBox.top,
            bottom: box.bottom - gridBox.top,
            center: box.top - gridBox.top + box.height / 2
          });
        });
        var next = [];
        if (board && Array.isArray(board.tickets)) {
          board.tickets.forEach(function (ticket) {
            if (!cards.has(ticket.ticketId)) return;
            (ticket.dependsOn || []).forEach(function (dependency) {
              var source = cards.get(dependency);
              var target = cards.get(ticket.ticketId);
              if (!source || !target) return;
              var startX = source.right + 5;
              var startY = source.center;
              var endX = target.left - 8;
              var endY = target.center;
              var bendX = Math.max(startX + 18, endX - 14);
              next.push({
                key: dependency + "->" + ticket.ticketId,
                from: dependency,
                to: ticket.ticketId,
                d: "M " + startX.toFixed(1) + " " + startY.toFixed(1) + " H " + bendX.toFixed(1) + " V " + endY.toFixed(1) + " H " + (endX - 3).toFixed(1)
              });
            });
          });
        }
        setEdges(next);
        setSize({ width: gridBox.width, height: gridBox.height });
      }, [open, board, filter, focus, revision]);

      if (!open) return null;

      var tickets = board && Array.isArray(board.tickets) ? board.tickets : [];
      var visible = tickets.filter(function (ticket) {
        if (filter === "active") return !BOARD_TERMINAL[ticket.status];
        if (filter === "blocked") return ticket.status === "blocked";
        return true;
      });
      var time = boardTimeTicks(tickets);
      var laneMap = new Map();
      if (board && Array.isArray(board.lanes)) {
        board.lanes.forEach(function (lane) { laneMap.set(lane.id, lane); });
      }
      visible.forEach(function (ticket) {
        if (!laneMap.has(ticket.laneId)) {
          laneMap.set(ticket.laneId, { id: ticket.laneId, label: ticket.laneLabel || "未分配", active: 0, total: 0 });
        }
      });
      var lanes = [];
      laneMap.forEach(function (lane) {
        var laneTickets = visible.filter(function (ticket) { return ticket.laneId === lane.id; });
        if (!laneTickets.length) return;
        lanes.push({ id: lane.id, label: lane.label, kind: lane.kind, tickets: laneTickets });
      });
      var counts = board && board.counts ? board.counts : { total: 0, active: 0, blocked: 0 };

      function toggleFocus(status) {
        setFocus(function (current) { return current === status ? null : status; });
      }

      var overlay = React.createElement(
        "div",
        {
          "data-ria-board": "",
          style: {
            position: "fixed",
            inset: 0,
            zIndex: 2147483000,
            background: "rgba(15, 23, 42, 0.42)",
            display: "flex",
            alignItems: "stretch",
            justifyContent: "center",
            padding: "22px",
            boxSizing: "border-box"
          },
          onMouseDown: function (event) { if (event.target === event.currentTarget) onClose(); }
        },
        React.createElement(
          "div",
          {
            role: "dialog",
            "aria-modal": "true",
            "aria-label": "Ria 任务看板",
            style: {
              flex: "1 1 auto",
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              background: "#f8fafc",
              borderRadius: "14px",
              boxShadow: "0 24px 70px rgba(15, 23, 42, 0.36)",
              overflow: "hidden"
            }
          },
          React.createElement(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "12px", padding: "14px 18px 12px", borderBottom: "1px solid #e2e8f0", background: "#ffffff" } },
            React.createElement("div", { style: { fontSize: "15px", fontWeight: "700", color: "#0f172a" } }, "Ria 任务看板"),
            React.createElement(
              "div",
              { style: { display: "flex", gap: "5px", flexWrap: "wrap" } },
              [{ id: "all", label: "全部" }, { id: "active", label: "活跃" }, { id: "blocked", label: "仅阻塞" }].map(function (item) {
                return React.createElement(
                  "button",
                  {
                    key: item.id,
                    type: "button",
                    onClick: function () { setFilter(item.id); },
                    style: {
                      cursor: "pointer",
                      padding: "3px 10px",
                      fontSize: "12px",
                      borderRadius: "999px",
                      border: "1px solid " + (filter === item.id ? "#0ea5e9" : "#dbe3ec"),
                      background: filter === item.id ? "#e0f2fe" : "#ffffff",
                      color: filter === item.id ? "#0369a1" : "#475569"
                    }
                  },
                  item.label
                );
              })
            ),
            React.createElement(
              "div",
              { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: "10px", fontSize: "11.5px", color: "#64748b" } },
              board ? counts.total + " 票 · 活跃 " + counts.active + " · 阻塞 " + counts.blocked + (timing ? " · 加载 " + Math.round(timing) + " ms" : "") : "",
              React.createElement(
                "button",
                {
                  type: "button",
                  "aria-label": "关闭看板",
                  onClick: onClose,
                  style: { cursor: "pointer", width: "28px", height: "28px", border: "1px solid #dbe3ec", borderRadius: "7px", background: "#ffffff", color: "#475569", fontSize: "15px", lineHeight: "1" }
                },
                "×"
              )
            )
          ),
          React.createElement(
            "div",
            { style: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center", padding: "8px 18px", borderBottom: "1px solid #e2e8f0", background: "#ffffff", fontSize: "11px", color: "#64748b" } },
            Object.keys(BOARD_STATUS).map(function (status) {
              var meta = BOARD_STATUS[status];
              return React.createElement(
                "button",
                {
                  key: status,
                  type: "button",
                  title: "点击高亮此状态",
                  onClick: function () { toggleFocus(status); },
                  style: {
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "2px 6px",
                    border: "1px solid " + (focus === status ? meta.color : "transparent"),
                    borderRadius: "5px",
                    background: focus === status ? "#f1f5f9" : "transparent",
                    color: "#475569",
                    fontSize: "11px"
                  }
                },
                React.createElement("span", { style: { width: "7px", height: "7px", borderRadius: "2px", background: meta.color } }),
                meta.label
              );
            }),
            React.createElement("span", { style: { marginLeft: "auto" } }, "箭头指向下游 · 悬停卡片高亮依赖")
          ),
          React.createElement(
            "div",
            { ref: scrollRef, style: { flex: "1 1 auto", overflow: "auto", padding: "12px 18px 18px" } },
            loading && !board ? React.createElement("div", { style: { padding: "40px", textAlign: "center", color: "#64748b", fontSize: "13px" } }, "正在读取任务…") : null,
            error ? React.createElement("div", { style: { padding: "30px", color: "#b91c1c", fontSize: "13px" } }, "看板读取失败：" + error) : null,
            !loading && !error && board && !tickets.length ? React.createElement("div", { style: { padding: "40px", textAlign: "center", color: "#64748b", fontSize: "13px" } }, "还没有任务。") : null,
            !loading && !error && board && tickets.length && !visible.length ? React.createElement("div", { style: { padding: "40px", textAlign: "center", color: "#64748b", fontSize: "13px" } }, "当前筛选下没有任务。") : null,
            board && visible.length ? React.createElement(
              "div",
              { ref: gridRef, style: { position: "relative", minWidth: "1280px" } },
              React.createElement(
                "svg",
                {
                  "aria-hidden": "true",
                  width: size.width,
                  height: size.height,
                  style: { position: "absolute", left: 0, top: 0, pointerEvents: "none", zIndex: 0, overflow: "visible" }
                },
                React.createElement(
                  "defs",
                  null,
                  React.createElement("marker", { id: "ria-board-arrow", markerWidth: "7", markerHeight: "7", refX: "6", refY: "3.5", orient: "auto" }, React.createElement("path", { d: "M 0 0 L 7 3.5 L 0 7 z", fill: "#7c93a8" }))
                ),
                edges.map(function (edge) {
                  var related = hover === edge.from || hover === edge.to;
                  var anyHover = hover !== null;
                  return React.createElement("path", {
                    key: edge.key,
                    d: edge.d,
                    fill: "none",
                    stroke: related ? "#0ea5e9" : "#94a3b8",
                    strokeWidth: related ? 1.8 : 1,
                    markerEnd: "url(#ria-board-arrow)",
                    opacity: anyHover ? (related ? 1 : 0.06) : 0.5
                  });
                })
              ),
              React.createElement(
                "div",
                { style: { display: "grid", gridTemplateColumns: "168px repeat(6, minmax(190px, 1fr))", position: "relative", zIndex: 1 } },
                React.createElement("div", { style: { position: "sticky", top: 0, zIndex: 4, background: "#f8fafc", borderBottom: "1px solid #e2e8f0", padding: "6px 8px", fontSize: "11px", color: "#94a3b8" } }, "项目 / 时间"),
                time.buckets.map(function (bucket, index) {
                  return React.createElement("div", { key: "tick-" + index, style: { position: "sticky", top: 0, zIndex: 4, background: "#f8fafc", borderBottom: "1px solid #e2e8f0", borderLeft: "1px dashed #e2e8f0", padding: "6px 8px", fontSize: "10.5px", color: "#64748b", whiteSpace: "nowrap" } }, bucket.label);
                }),
                lanes.map(function (lane) {
                  var cells = [];
                  cells.push(React.createElement(
                    "div",
                    { key: "lane-" + lane.id, style: { padding: "10px 8px 4px", fontSize: "12px", fontWeight: "600", color: "#334155", borderBottom: "1px solid #e8eef5", overflow: "hidden" } },
                    React.createElement("div", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: lane.label }, lane.label),
                    React.createElement("div", { style: { marginTop: "2px", fontSize: "10px", color: "#94a3b8", fontWeight: "400" } }, lane.tickets.length + " 票" + (lane.kind === "unassigned" ? " · 未归属" : ""))
                  ));
                  for (var index = 0; index < BOARD_BUCKETS; index += 1) {
                    var cellTickets = lane.tickets.filter(function (ticket) { return boardBucket(ticket, time) === index; });
                    cells.push(React.createElement(
                      "div",
                      { key: "cell-" + lane.id + "-" + index, style: { minHeight: "44px", padding: "8px 6px 2px", borderLeft: "1px dashed #e8eef5", borderBottom: "1px solid #e8eef5" } },
                      cellTickets.map(function (ticket) {
                        return React.createElement(BoardCard, {
                          key: ticket.ticketId,
                          ticket: ticket,
                          dimmed: focus !== null && ticket.status !== focus,
                          onHover: setHover
                        });
                      })
                    ));
                  }
                  return React.createElement(React.Fragment, { key: "lane-row-" + lane.id }, cells);
                })
              )
            ) : null
          )
        )
      );
      var portal = ReactDOM && typeof ReactDOM.createPortal === "function" ? ReactDOM.createPortal(overlay, document.body) : overlay;
      return portal;
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          { name: "settings.section", id: "ria-settings", order: 25, label: "Ria" },
          function () { return React.createElement(RiaSettingsSection); }
        );
      });
      ctx.slots.inject("conversation.chat.turnTail", function () {
        return ctx.slots.register(
          {
            name: "conversation.chat.turnTail",
            id: "ria-dispatch-note",
            order: 10,
            inject: function (sessionId) { return { sessionId: String(sessionId) }; }
          },
          DispatchNoteCard
        );
      });
      ctx.slots.inject("conversation.input.dock", function () {
        return ctx.slots.register(
          {
            name: "conversation.input.dock",
            id: "ria-welcome",
            order: 5,
            inject: function (sessionId) { return { sessionId: String(sessionId), sessions: ctx.sessions }; }
          },
          WelcomeCard
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
            label: function () { return "Ria"; }
          },
          function (props) {
            return React.createElement(RiaPanelEntry, { ctx: ctx, size: props && props.size });
          }
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "sessions", "uiWorkspace"];
    return module.exports;
  }
});

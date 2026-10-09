// dsh-done-badge — 浏览器半边（设置页「弹窗角标通知」）
//
// 由 dsh-client-modules 加载到 /plugins/dsh-done-badge/client.js，走宿主的
// lazy-CJS 模块表执行（window.__ModuleLoader__.load）。工厂体里只能 require
// 平台种子模块（react / react/jsx-runtime）和已注册的客户端 bundle。
//
// 这一页提供两个开关：
//   - 任务栏角标：离开 DSH 期间完成任务时，在任务栏 DSH 图标上显示红色数字
//   - Windows 通知：同一时刻弹右下角系统通知
// 开关走宿主路由 /dsh-badge/config（GET 读 / POST 写），宿主内存里的状态立即
// 改变，所以"点开就是开、点关就是关"，不需要重启 DSH。写盘位置 $DSH_HOME/
// dsh-done-badge.json，重启后仍然是上次的选择。

window.__ModuleLoader__.load({
  id: "dsh-done-badge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // 宿主不隔离 loader-entry 工厂：这里抛一个错就会变成 "1 entry did not activate"，
    // 整个 web shell 起不来。所以连 require("react") 都要包住，拿不到就退化成 no-op。
    var React = null;
    try {
      React = require("react");
    } catch (err) {
      React = null;
    }
    if (!React || typeof React.createElement !== "function") {
      try { console.warn("[dsh-done-badge] react unavailable — settings page skipped"); } catch (e) {}
      module.exports = { name: "dsh-done-badge", inject: [], apply: function () {} };
      return module.exports;
    }

    /** 宿主侧设置与实时状态（GET 读 / POST 写）。 */
    var CONFIG_URL = "/dsh-badge/config";
    /** 立刻发一条测试通知，验证"打开就生效"。 */
    var TEST_URL = "/dsh-badge/test";
    /** 状态轮询间隔：设置页开着时同步显示"当前离开期间已完成 N 个"。 */
    var POLL_MS = 2000;

    var COLOR_PRIMARY = "var(--dsw-alias-label-primary, #1a1a1a)";
    var COLOR_SECONDARY = "var(--dsw-alias-label-secondary, #666)";
    var COLOR_TERTIARY = "var(--dsw-alias-label-tertiary, #999)";
    var COLOR_BORDER = "var(--dsw-alias-border-l1, rgba(127,127,127,.22))";
    var COLOR_CARD = "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))";
    var COLOR_ACCENT = "var(--dsw-alias-brand-primary, #4d6bfe)";

    /** 原生感的开关（不用宿主内部组件，避免跨版本耦合）。 */
    function Switch(props) {
      var on = !!props.checked;
      var disabled = !!props.disabled;
      return React.createElement(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": on,
          "aria-label": props.label,
          disabled: disabled,
          onClick: function () {
            if (!disabled) props.onChange(!on);
          },
          style: {
            position: "relative",
            flex: "none",
            width: "44px",
            height: "24px",
            borderRadius: "12px",
            border: "none",
            padding: 0,
            cursor: disabled ? "default" : "pointer",
            opacity: disabled ? 0.55 : 1,
            background: on ? COLOR_ACCENT : "var(--dsw-alias-bg-layer-3, rgba(127,127,127,.35))",
            transition: "background .18s ease"
          }
        },
        React.createElement("span", {
          style: {
            position: "absolute",
            top: "2px",
            left: on ? "22px" : "2px",
            width: "20px",
            height: "20px",
            borderRadius: "50%",
            background: "#fff",
            boxShadow: "0 1px 3px rgba(0,0,0,.28)",
            transition: "left .18s ease"
          }
        })
      );
    }

    /** 一行设置：标题 + 说明 + 右侧开关。 */
    function Row(props) {
      return React.createElement(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "flex-start",
            gap: "16px",
            padding: "14px 16px",
            borderTop: "1px solid " + COLOR_BORDER
          }
        },
        React.createElement(
          "div",
          { style: { flex: "1 1 auto", minWidth: 0 } },
          React.createElement(
            "div",
            { style: { fontSize: "14px", fontWeight: 500, color: COLOR_PRIMARY } },
            props.title
          ),
          React.createElement(
            "div",
            { style: { marginTop: "4px", fontSize: "12px", lineHeight: 1.6, color: COLOR_TERTIARY } },
            props.desc
          )
        ),
        React.createElement(Switch, {
          checked: props.checked,
          disabled: props.disabled,
          label: props.title,
          onChange: props.onChange
        })
      );
    }

    function DoneBadgeSection() {
      var stateHook = React.useState(null);
      var state = stateHook[0];
      var setState = stateHook[1];
      var msgHook = React.useState("");
      var msg = msgHook[0];
      var setMsg = msgHook[1];
      var busyHook = React.useState(false);
      var busy = busyHook[0];
      var setBusy = busyHook[1];

      // 系统通知(WinRT ToastNotificationManager)只有 Windows 有。宿主 config 路由会带
      // 回 platform, 非 Windows 上把这一行和测试按钮一起禁掉 —— 不给一个点了也不会生效的开关。
      var isWindows = ((state && state.platform) || "win32") === "win32";

      React.useEffect(function () {
        var alive = true;
        function pull() {
          fetch(CONFIG_URL, { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (alive && j && j.ok) setState(j); })
            .catch(function () {});
        }
        pull();
        var timer = setInterval(pull, POLL_MS);
        return function () { alive = false; clearInterval(timer); };
      }, []);

      function apply(patch) {
        setBusy(true);
        setMsg("");
        fetch(CONFIG_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch)
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j && j.ok) {
              setState(j);
              setMsg("已保存并立即生效");
            } else {
              setMsg("保存失败：" + ((j && j.error) || "未知错误"));
            }
          })
          .catch(function (err) { setMsg("保存失败：" + String((err && err.message) || err)); })
          .then(function () { setBusy(false); });
      }

      function sendTest() {
        // 开关关着就不发 —— "点关就是关"，测试按钮也不能绕过设置。
        if (!(state ? !!state.notify : true)) {
          setMsg("Windows 通知已关闭，未发送");
          return;
        }
        if (!isWindows) {
          setMsg("当前系统不是 Windows，无法发送系统通知");
          return;
        }
        setBusy(true);
        setMsg("");
        fetch(TEST_URL, { method: "POST" })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j && j.ok) setMsg("测试通知已发出（看右下角）");
            else if (j && j.error === "notify-off") setMsg("Windows 通知已关闭，未发送");
            else setMsg("测试通知发送失败：" + ((j && j.error) || "未知错误"));
          })
          .catch(function (err) { setMsg("测试通知发送失败：" + String((err && err.message) || err)); })
          .then(function () { setBusy(false); });
      }

      var badge = state ? !!state.badge : true;
      var notify = state ? !!state.notify : true;
      var count = state && typeof state.count === "number" ? state.count : 0;
      var live = state
        ? (count > 0 ? "当前离开期间已完成 " + count + " 个任务" : "目前没有待提醒的任务")
        : "正在读取状态…";
      // 测试按钮只在"Windows 且通知开关打开"时可用。
      var testEnabled = isWindows && notify;

      return React.createElement(
        "div",
        { style: { padding: "20px 24px 32px", maxWidth: "720px" } },
        React.createElement(
          "div",
          { style: { fontSize: "16px", fontWeight: 600, color: COLOR_PRIMARY } },
          "弹窗角标通知"
        ),
        React.createElement(
          "div",
          { style: { marginTop: "6px", fontSize: "12.5px", lineHeight: 1.7, color: COLOR_SECONDARY } },
          "当 DSH 不在前台（切屏、最小化、去刷抖音）时有会话整轮完成，就在任务栏 DSH 图标右上角累加红色数字，并弹出 Windows 右下角通知。切回 DSH 后角标自动清除。开关立即生效，不需要重启。"
        ),
        React.createElement(
          "div",
          {
            style: {
              marginTop: "16px",
              border: "1px solid " + COLOR_BORDER,
              borderRadius: "10px",
              background: COLOR_CARD,
              overflow: "hidden"
            }
          },
          React.createElement(Row, {
            title: "任务栏角标",
            desc: isWindows
              ? "在任务栏 DSH 图标上显示红色数字，数字 = 离开期间完成的任务数。"
              : "非 Windows 系统没有任务栏角标，改为在 DSH 窗口右上角显示红色数字。",
            checked: badge,
            disabled: busy,
            onChange: function (next) { apply({ badge: next }); }
          }),
          React.createElement(Row, {
            title: "Windows 通知",
            desc: isWindows
              ? "同一时刻弹出右下角系统通知气泡，点开不影响角标计数。"
              : "系统通知是 Windows 专有功能（WinRT），当前系统不可用；开关已停用。",
            checked: notify,
            disabled: busy || !isWindows,
            onChange: function (next) { apply({ notify: next }); }
          })
        ),
        React.createElement(
          "div",
          { style: { marginTop: "12px", fontSize: "12px", color: COLOR_TERTIARY } },
          live
        ),
        React.createElement(
          "div",
          { style: { marginTop: "14px", display: "flex", alignItems: "center", gap: "12px" } },
          React.createElement(
            "button",
            {
              type: "button",
              disabled: busy || !testEnabled,
              onClick: sendTest,
              title: !isWindows ? "系统通知仅 Windows 可用" : (notify ? "立刻弹一条测试通知" : "Windows 通知已关闭"),
              style: {
                padding: "7px 14px",
                fontSize: "13px",
                borderRadius: "8px",
                border: "1px solid " + COLOR_BORDER,
                background: "transparent",
                color: testEnabled ? COLOR_PRIMARY : COLOR_TERTIARY,
                opacity: testEnabled ? 1 : 0.55,
                cursor: busy || !testEnabled ? "default" : "pointer"
              }
            },
            !isWindows
              ? "发送测试通知（仅 Windows）"
              : (notify ? "发送测试通知" : "发送测试通知（Windows 通知已关闭）")
          ),
          msg
            ? React.createElement(
                "span",
                { style: { fontSize: "12px", color: COLOR_SECONDARY } },
                msg
              )
            : null
        ),
        React.createElement(
          "div",
          { style: { marginTop: "22px", fontSize: "11.5px", lineHeight: 1.7, color: COLOR_TERTIARY } },
          "说明：只统计整轮真正结束的顶层会话，子代理会话不重复计数；被中断/取消的一轮不计入。一条用户消息为一轮 —— 所以不会按 todo 步骤刷屏。"
        )
      );
    }

    var name = "dsh-done-badge";
    // 注意：这里是 **cordis 服务名**，不是 npm 包名！
    // 本机 client 服务目录只有 layout / locale / sessions / slots / theme / timer /
    // uiWorkspace / workspaces 这几个键。写成包名会让 cordis 永远 pending
    // （"waiting for services: @deepseek-ai/dsh-client-ui-slots"），整个 web boot 以
    // "1 entry did not activate" 失败、应用起不来。参照 dsh-music-player：inject = ['slots']。
    // package.json 里的 dsh.client.inject 才是包名（模块级提示），两者语义不同。
    var inject = ["slots"];

    function apply(ctx) {
      // 兜底：这一半绝不能把整个 web shell 拖垮（宿主不会隔离 loader-entry 工厂，
      // 一个抛错就是 "1 entry did not activate"）。服务缺失就安静跳过设置页。
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") {
        try { console.warn("[dsh-done-badge] slots service unavailable — settings page skipped"); } catch (e) {}
        return;
      }
      try {
        // 惰性注册：settings.section 要等主机把它声明出来再挂页。
        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register(
            {
              name: "settings.section",
              id: "done-badge",
              order: 60,
              label: "弹窗角标通知",
              inject: function () { return {}; }
            },
            DoneBadgeSection
          );
        });
      } catch (err) {
        try { console.warn("[dsh-done-badge] settings page registration failed:", err && err.message); } catch (e) {}
      }
    }

    module.exports = { name: name, inject: inject, apply: apply };
    return module.exports;
  }
});

(function () {
  "use strict";
  const plugins = window.__HERMES_PLUGINS__;
  if (plugins && typeof plugins.register === "function") {
    plugins.register("originpost-board-approvals", function OriginPostBoardApprovals() { return null; });
  }
})();

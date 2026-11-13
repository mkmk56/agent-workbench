/* Agent Workbench · UI mockups
 * Only the theme toggle is interactive. Everything else is static.
 */
(function () {
  var root = document.documentElement;
  var STORAGE_KEY = "aw-mockup-theme";

  try {
    var saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") {
      root.dataset.theme = saved;
    }
  } catch (error) {
    /* localStorage may be unavailable; light is the default. */
  }

  /* Deep link for design review: tasks.html#dark / tasks.html#light */
  if (window.location.hash === "#dark" || window.location.hash === "#light") {
    root.dataset.theme = window.location.hash.slice(1);
  }

  var toggles = document.querySelectorAll("[data-theme-toggle]");

  function sync() {
    var isDark = root.dataset.theme === "dark";
    Array.prototype.forEach.call(toggles, function (button) {
      button.setAttribute(
        "aria-label",
        isDark ? "切换到浅色模式" : "切换到深色模式"
      );
      button.setAttribute(
        "title",
        isDark ? "切换到浅色模式" : "切换到深色模式"
      );
      var use = button.querySelector("use");
      if (use) {
        use.setAttribute("href", isDark ? "#icon-sun" : "#icon-moon");
      }
    });
  }

  Array.prototype.forEach.call(toggles, function (button) {
    button.addEventListener("click", function () {
      var next = root.dataset.theme === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch (error) {
        /* ignore */
      }
      sync();
    });
  });

  sync();
})();
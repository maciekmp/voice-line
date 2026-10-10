(function () {
  const geometry = Object.freeze({ windowWidth: 64, windowHeight: 80, buttonLeft: 5, buttonTop: 5, buttonSize: 54 });
  if (typeof module !== 'undefined') module.exports = geometry;
  if (typeof document !== 'undefined') {
    for (const [name, value] of Object.entries(geometry)) {
      document.documentElement.style.setProperty(`--orb-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, `${value}px`);
    }
  }
})();

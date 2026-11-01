// Apply the saved edition before styles and React paint the workspace.
(function () {
  var theme = 'original';
  try {
    var saved = localStorage.getItem('oneshot.appearance');
    if (['original', 'onyx', 'champagne', 'vice'].indexOf(saved) !== -1) theme = saved;
  } catch (_) { /* The default also works when browser storage is unavailable. */ }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'champagne' ? 'light' : 'dark';
})();

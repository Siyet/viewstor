/*
 * Shared webview shell.
 *
 * Loaded as the first script in every webview that uses
 * @vscode-elements/elements custom elements. Centralizes the element
 * bundle import path so a future version bump touches one file.
 *
 * Custom elements register themselves on import side-effect, so simply
 * loading this script via <script src="..."> before any element usage
 * is enough — there is nothing to call.
 *
 * The bundled file already contains every <vscode-*> component used by
 * the forms (textfield, single-select, checkbox, button, collapsible,
 * tabs, icon, etc.).
 */
/* eslint-disable */
(function () {
  // Marker used by tests / debugging to confirm the shell ran.
  window.__viewstorShellLoaded = true;
})();

/*
 * HablaHora: chat del negocio en su propio sitio.
 *
 *   <script src="https://<chat>/embed.js" data-slug="salon-aurora" async></script>
 *
 * Agrega un botón flotante del color del negocio que abre el chat en un panel
 * (pantalla completa en el teléfono). Sin dependencias. Si el chat del negocio
 * no está activo, no muestra nada.
 */
(function () {
  "use strict";

  function init(script) {
    if (!script || window.__hablahoraChatEmbed) return;
    var slug = script.getAttribute("data-slug");
    if (!slug) return;
    window.__hablahoraChatEmbed = true;
    var origin = new URL(script.src, window.location.href).origin;
    var en = (navigator.language || "").toLowerCase().indexOf("en") === 0;

    return fetch(origin + "/api/chat/" + encodeURIComponent(slug))
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (info) {
        if (info && info.available) mount(info);
      })
      .catch(function () {
        /* sin chat: el sitio sigue igual */
      });

    function mount(info) {
      var openLabel = en ? "Chat with " + info.name : "Abrir el chat de " + info.name;
      var closeLabel = en ? "Close chat" : "Cerrar chat";
      var mobile = window.matchMedia && window.matchMedia("(max-width: 480px)").matches;

      var button = document.createElement("button");
      button.type = "button";
      button.setAttribute("aria-label", openLabel);
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("data-hablahora-chat", "button");
      button.innerHTML =
        '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A2.5 2.5 0 0 1 3 13.5v-8Z" fill="currentColor"/></svg>';
      setStyle(button, {
        position: "fixed",
        right: "20px",
        bottom: "20px",
        width: "60px",
        height: "60px",
        borderRadius: "50%",
        border: "0",
        background: info.accent,
        color: "#fff",
        cursor: "pointer",
        boxShadow: "0 6px 20px rgba(0,0,0,.25)",
        zIndex: "2147483000",
        display: "grid",
        placeItems: "center",
      });

      var panel = document.createElement("div");
      panel.setAttribute("data-hablahora-chat", "panel");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", info.name);
      setStyle(
        panel,
        mobile
          ? { position: "fixed", inset: "0", zIndex: "2147483001", display: "none", background: "#fff" }
          : {
              position: "fixed",
              right: "20px",
              bottom: "92px",
              width: "380px",
              height: "min(640px, calc(100vh - 120px))",
              borderRadius: "18px",
              overflow: "hidden",
              boxShadow: "0 12px 40px rgba(0,0,0,.28)",
              zIndex: "2147483001",
              display: "none",
              background: "#fff",
            },
      );
      var frame = null; // el chat se carga recién al abrir

      function open() {
        if (!frame) {
          frame = document.createElement("iframe");
          frame.src = origin + "/" + encodeURIComponent(slug) + "?embed=1";
          frame.title = info.name;
          frame.setAttribute("allow", "clipboard-write");
          setStyle(frame, { width: "100%", height: "100%", border: "0", display: "block" });
          panel.appendChild(frame);
        }
        panel.style.display = "block";
        button.setAttribute("aria-expanded", "true");
        button.setAttribute("aria-label", closeLabel);
        if (mobile) button.style.display = "none";
      }
      function close() {
        panel.style.display = "none";
        button.style.display = "grid";
        button.setAttribute("aria-expanded", "false");
        button.setAttribute("aria-label", openLabel);
        button.focus();
      }

      button.addEventListener("click", function () {
        panel.style.display === "block" ? close() : open();
      });
      // el botón "cerrar" del chat incrustado avisa con postMessage
      window.addEventListener("message", function (e) {
        if (e.origin === origin && e.data && e.data.type === "hablahora-chat:close") close();
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && panel.style.display === "block") close();
      });

      document.body.appendChild(panel);
      document.body.appendChild(button);
    }
  }

  function setStyle(el, styles) {
    for (var k in styles) el.style[k] = styles[k];
  }

  window.HablaHoraChatEmbed = { init: init };
  if (document.currentScript) init(document.currentScript);
})();

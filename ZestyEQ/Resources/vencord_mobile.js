(() => {
    let isSidebarOpen = false;

    const waitForVencord = setInterval(() => {
        if (window.Vencord && Vencord.Webpack && Vencord.Webpack.Common) {
            clearInterval(waitForVencord);

            const { findLazy, Common, onceReady } = Vencord.Webpack;
            const ModalEscapeHandler = findLazy(m => m.binds?.length === 1 && m.binds[0] === "esc");

            onceReady.then(() => {
                Common.FluxDispatcher.subscribe("MOBILE_WEB_SIDEBAR_OPEN", () => { isSidebarOpen = true; });
                Common.FluxDispatcher.subscribe("MOBILE_WEB_SIDEBAR_CLOSE", () => { isSidebarOpen = false; });
            });
        }
    }, 100);

    window.VencordMobile = {
        onBackPress() {
            if (window.Vencord && Vencord.Webpack) {
                const { findLazy, Common } = Vencord.Webpack;
                const ModalEscapeHandler = findLazy(m => m.binds?.length === 1 && m.binds[0] === "esc");
                if (ModalEscapeHandler && ModalEscapeHandler.action() === false) return true;
            }

            const quickCssWin = window.__VENCORD_MONACO_WIN__?.deref();
            if (quickCssWin && !quickCssWin.closed) {
                quickCssWin.close();
                delete window.__VENCORD_MONACO_WIN__;
                return true;
            }

            if (!isSidebarOpen && window.Vencord && Vencord.Webpack && Vencord.Webpack.Common) {
                Vencord.Webpack.Common.FluxDispatcher.dispatch({ type: "MOBILE_WEB_SIDEBAR_OPEN" });
                return true;
            }

            return false;
        }
    };

    document.addEventListener("DOMContentLoaded", () => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.type = "text/css";
        link.href = "https://github.com/Vendicated/Vencord/releases/download/devbuild/browser.css";
        document.documentElement.appendChild(link);
    }, { once: true });

    // Notify iOS that page is loaded
    setTimeout(() => {
        try {
            window.webkit.messageHandlers.vencordMobile.postMessage({ type: 'pageLoaded' });
        } catch (e) {}
    }, 3000);
})();

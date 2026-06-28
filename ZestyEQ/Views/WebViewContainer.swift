import SwiftUI
import WebKit

struct WebViewContainer: UIViewRepresentable {
    @ObservedObject var manager: WebViewManager
    @Binding var isLoading: Bool

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let userContentController = WKUserContentController()

        // JavaScript bridge - listen for messages from JS
        userContentController.add(context.coordinator, name: "vencordMobile")

        let preferences = WKWebpagePreferences()
        preferences.allowsContentJavaScript = true
        config.defaultWebpagePreferences = preferences

        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        userContentController.addUserScript(createLoadScript())

        config.userContentController = userContentController

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0x1a/255, green: 0x1a/255, blue: 0x2e/255, alpha: 1)

        manager.webView = webView

        loadDiscord(in: webView, desktop: manager.desktopSite)

        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        if manager.needsReload {
            manager.needsReload = false
            loadDiscord(in: uiView, desktop: manager.desktopSite)
        }
    }

    private func loadDiscord(in webView: WKWebView, desktop: Bool) {
        webView.customUserAgent = desktop ? Constants.desktopUA : Constants.mobileUA
        let url = URL(string: "https://discord.com/app")!
        webView.load(URLRequest(url: url))
    }

    private func createLoadScript() -> WKUserScript {
        let source = """
        window.VencordMobileNative = {
            goBack: function() {
                window.webkit.messageHandlers.vencordMobile.postMessage({type: 'goBack'});
            }
        };
        """
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let parent: WebViewContainer

        init(_ parent: WebViewContainer) {
            self.parent = parent
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  let type = body["type"] as? String else { return }

            switch type {
            case "goBack":
                if parent.manager.webView?.canGoBack == true {
                    parent.manager.webView?.goBack()
                }
            case "pageLoaded":
                DispatchQueue.main.async {
                    self.parent.isLoading = false
                }
            case "log":
                if let text = body["text"] as? String {
                    print("[ZestyEQ JS] \(text)")
                }
            default:
                break
            }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            DispatchQueue.main.async {
                self.parent.isLoading = true
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            injectJavaScriptBundles(webView)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            DispatchQueue.main.async {
                self.parent.isLoading = false
            }
        }

        private func injectJavaScriptBundles(_ webView: WKWebView) {
            guard let vencordMobilePath = Bundle.main.path(forResource: "vencord_mobile", ofType: "js"),
                  let zestyEqPath = Bundle.main.path(forResource: "zesty_eq", ofType: "js") else { return }

            do {
                let vencordMobileJS = try String(contentsOfFile: vencordMobilePath, encoding: .utf8)
                let zestyEqJS = try String(contentsOfFile: zestyEqPath, encoding: .utf8)

                webView.evaluateJavaScript(vencordMobileJS) { _, error in
                    if let error = error {
                        print("[ZestyEQ] vencord_mobile injection error: \(error)")
                    }
                }

                webView.evaluateJavaScript(zestyEqJS) { _, error in
                    if let error = error {
                        print("[ZestyEQ] zesty_eq injection error: \(error)")
                    }
                }

                // Fetch Vencord browser.js from GitHub
                fetchVencordRuntime { runtime in
                    if let runtime = runtime {
                        webView.evaluateJavaScript(runtime) { _, error in
                            if let error = error {
                                print("[ZestyEQ] Vencord runtime injection error: \(error)")
                            }
                        }
                    }
                }
            } catch {
                print("[ZestyEQ] Error reading JS bundles: \(error)")
            }
        }

        private func fetchVencordRuntime(completion: @escaping (String?) -> Void) {
            guard let url = URL(string: Constants.jsBundleURL) else {
                completion(nil)
                return
            }

            URLSession.shared.dataTask(with: url) { data, _, error in
                if let data = data, let js = String(data: data, encoding: .utf8) {
                    completion(js)
                } else {
                    print("[ZestyEQ] Failed to fetch Vencord runtime: \(error?.localizedDescription ?? "unknown")")
                    completion(nil)
                }
            }.resume()
        }


    }
}

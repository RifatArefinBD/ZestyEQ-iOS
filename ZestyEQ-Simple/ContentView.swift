import SwiftUI
import WebKit

struct ContentView: View {
    var body: some View {
        WebView()
            .edgesIgnoringSafeArea(.all)
            .onAppear {
                requestPermissions()
            }
    }

    func requestPermissions() {
        AVAudioSession.sharedInstance().requestRecordPermission { _ in }
        AVCaptureDevice.requestAccess(for: .video) { _ in }
    }
}

struct WebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let userContentController = WKUserContentController()

        userContentController.add(context.coordinator, name: "vencordMobile")

        userContentController.addUserScript(vencordBridgeScript())
        userContentController.addUserScript(patchScript())

        config.userContentController = userContentController
        config.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator

        let url = URL(string: "https://discord.com/app")!
        webView.load(URLRequest(url: url))

        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    func vencordBridgeScript() -> WKUserScript {
        let source = """
        window.VencordMobileNative = {
            goBack: function() {
                window.webkit.messageHandlers.vencordMobile.postMessage({type: 'goBack'});
            }
        };
        """
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false)
    }

    func patchScript() -> WKUserScript {
        let source = """
        window.VencordMobile = true;
        """
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false)
    }

    class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        override init() { super.init() }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  let type = body["type"] as? String else { return }

            switch type {
            case "goBack":
                print("[ZestyEQ] goBack requested")
            case "log":
                if let text = body["text"] as? String {
                    print("[ZestyEQ JS] \(text)")
                }
            default:
                break
            }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            print("[ZestyEQ] Loading...")
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            print("[ZestyEQ] Page loaded, injecting scripts...")
            injectScripts(webView)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            print("[ZestyEQ] Load failed: \(error.localizedDescription)")
        }

        func injectScripts(_ webView: WKWebView) {
            guard let vencordPath = Bundle.main.path(forResource: "vencord_mobile", ofType: "js"),
                  let zestyPath = Bundle.main.path(forResource: "zesty_eq", ofType: "js") else {
                print("[ZestyEQ] JS files not found in bundle")
                return
            }

            do {
                let vencordJS = try String(contentsOfFile: vencordPath, encoding: .utf8)
                let zestyJS = try String(contentsOfFile: zestyPath, encoding: .utf8)

                webView.evaluateJavaScript(vencordJS) { _, err in
                    if let err = err { print("[ZestyEQ] vencord error: \(err)") }
                    else { print("[ZestyEQ] vencord injected") }
                }
                webView.evaluateJavaScript(zestyJS) { _, err in
                    if let err = err { print("[ZestyEQ] zesty error: \(err)") }
                    else { print("[ZestyEQ] zesty_eq injected") }
                }
            } catch {
                print("[ZestyEQ] Error: \(error)")
            }
        }
    }
}

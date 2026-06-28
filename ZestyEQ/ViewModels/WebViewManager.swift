import Foundation
import WebKit

class WebViewManager: ObservableObject {
    @Published var desktopSite: Bool = UserDefaults.standard.bool(forKey: "desktopSite") {
        didSet {
            UserDefaults.standard.set(desktopSite, forKey: "desktopSite")
            needsReload = true
        }
    }
    @Published var needsReload = false

    weak var webView: WKWebView?

    func goBack() {
        if webView?.canGoBack == true {
            webView?.goBack()
        }
    }

    func reload() {
        webView?.reload()
    }
}

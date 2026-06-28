import Foundation

struct Logger {
    static func log(_ message: String) {
        print("[ZestyEQ] \(message)")
    }

    static func error(_ message: String) {
        print("[ZestyEQ ERROR] \(message)")
    }
}

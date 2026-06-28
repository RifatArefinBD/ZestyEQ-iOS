import AVFoundation
import Photos

class PermissionManager {
    static let shared = PermissionManager()

    func requestMicrophonePermission() {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            if granted {
                print("[ZestyEQ] Microphone permission granted")
            } else {
                print("[ZestyEQ] Microphone permission denied")
            }
        }
    }

    func requestCameraPermission() {
        AVCaptureDevice.requestAccess(for: .video) { granted in
            if granted {
                print("[ZestyEQ] Camera permission granted")
            } else {
                print("[ZestyEQ] Camera permission denied")
            }
        }
    }

    func microphonePermissionStatus() -> AVAudioSession.RecordPermission {
        return AVAudioSession.sharedInstance().recordPermission
    }

    func cameraPermissionStatus() -> AVAuthorizationStatus {
        return AVCaptureDevice.authorizationStatus(for: .video)
    }
}

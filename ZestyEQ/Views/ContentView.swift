import SwiftUI

struct ContentView: View {
    @StateObject private var webViewManager = WebViewManager()
    @State private var showSettings = false
    @State private var isLoading = true

    var body: some View {
        ZStack {
            WebViewContainer(manager: webViewManager, isLoading: $isLoading)

            if isLoading {
                VStack {
                    ProgressView()
                        .scaleEffect(1.5)
                        .progressViewStyle(CircularProgressViewStyle(tint: Color(red: 0x1a/255, green: 0x1a/255, blue: 0x2e/255)))
                    Text("Loading Zesty EQ...")
                        .foregroundColor(Color(red: 0xe9/255, green: 0x45/255, blue: 0x60/255))
                        .padding(.top, 12)
                }
                .padding(24)
                .background(Color.white.opacity(0.9))
                .cornerRadius(12)
            }

            VStack {
                Spacer()
                HStack {
                    Spacer()
                    Button(action: { showSettings = true }) {
                        Image(systemName: "gearshape.fill")
                            .font(.system(size: 20))
                            .foregroundColor(Color(red: 0xe9/255, green: 0x45/255, blue: 0x60/255))
                            .frame(width: 48, height: 48)
                            .background(Color(red: 0x1a/255, green: 0x1a/255, blue: 0x2e/255))
                            .clipShape(Circle())
                            .overlay(Circle().stroke(Color(red: 0xe9/255, green: 0x45/255, blue: 0x60/255), lineWidth: 2))
                    }
                    .shadow(color: .black.opacity(0.3), radius: 6, x: 0, y: 3)
                    .padding(.trailing, 16)
                    .padding(.bottom, 32)
                }
            }
        }
        .edgesIgnoringSafeArea(.all)
        .sheet(isPresented: $showSettings) {
            SettingsView(manager: webViewManager)
        }
        .onAppear {
            PermissionManager.shared.requestMicrophonePermission()
            PermissionManager.shared.requestCameraPermission()
        }
    }
}

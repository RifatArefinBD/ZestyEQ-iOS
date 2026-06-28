import SwiftUI

struct SettingsView: View {
    @ObservedObject var manager: WebViewManager
    @Environment(\.presentationMode) var presentationMode

    @AppStorage("desktopSite") private var desktopSite = false

    var body: some View {
        NavigationView {
            ZStack {
                Color(red: 0x1a/255, green: 0x1a/255, blue: 0x2e/255)
                    .edgesIgnoringSafeArea(.all)

                VStack(spacing: 0) {
                    VStack(spacing: 4) {
                        Text("Settings")
                            .font(.title2)
                            .fontWeight(.bold)
                            .foregroundColor(.white)
                        Text("Zesty EQ")
                            .font(.caption)
                            .foregroundColor(Color(red: 0xe9/255, green: 0x45/255, blue: 0x60/255))
                    }
                    .padding()
                    .frame(maxWidth: .infinity)
                    .background(Color(red: 0xe9/255, green: 0x45/255, blue: 0x60/255).opacity(0.85))

                    Form {
                        Section {
                            Toggle(isOn: $desktopSite) {
                                HStack {
                                    Image(systemName: "desktopcomputer")
                                        .foregroundColor(Color(red: 0xe9/255, green: 0x45/255, blue: 0x60/255))
                                    Text("Desktop Site")
                                        .foregroundColor(.white)
                                }
                            }
                            .toggleStyle(SwitchToggleStyle(tint: Color(red: 0xe9/255, green: 0x45/255, blue: 0x60/255)))
                            .listRowBackground(Color(red: 0x16/255, green: 0x16/255, blue: 0x2a/255))

                            Text("Use the desktop version of Discord for a better experience with Zesty EQ features.")
                                .font(.caption)
                                .foregroundColor(.gray)
                                .listRowBackground(Color(red: 0x16/255, green: 0x16/255, blue: 0x2a/255))
                        }

                        Section {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("CREDITS")
                                    .font(.headline)
                                    .foregroundColor(Color(red: 0xe9/255, green: 0x45/255, blue: 0x60/255))

                                Text("Xenon & PocketEQ")
                                    .font(.body)
                                    .foregroundColor(.white)

                                Text("Special thanks to the Vencord team for making this possible.")
                                    .font(.caption)
                                    .foregroundColor(.gray)
                            }
                            .listRowBackground(Color(red: 0x16/255, green: 0x16/255, blue: 0x2a/255))
                        }

                        Section {
                            HStack {
                                Image(systemName: "info.circle")
                                    .foregroundColor(Color(red: 0xe9/255, green: 0x45/255, blue: 0x60/255))
                                Text("Version 1.0.0")
                                    .foregroundColor(.white)
                            }
                            .listRowBackground(Color(red: 0x16/255, green: 0x16/255, blue: 0x2a/255))
                        }
                    }
                    .background(Color(red: 0x16/255, green: 0x16/255, blue: 0x2a/255))
                    .scrollContentBackgroundHidden()
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { presentationMode.wrappedValue.dismiss() }
                        .foregroundColor(Color(red: 0xe9/255, green: 0x45/255, blue: 0x60/255))
                }
            }
        }
    }
}

@available(iOS, introduced: 13.0)
extension View {
    @ViewBuilder
    func scrollContentBackgroundHidden() -> some View {
        if #available(iOS 16.0, *) {
            self.scrollContentBackground(.hidden)
        } else {
            self
        }
    }
}

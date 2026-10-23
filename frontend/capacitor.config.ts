import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android shell around the built frontend. The web app is bundled inside
 * the APK; it talks to whichever AdviSha server address the user saves on
 * the sign-in screen (laptop on the same Wi-Fi, an ngrok URL, or the hosted
 * server). `cleartext` allows plain http:// to a laptop on the LAN.
 */
const config: CapacitorConfig = {
  appId: 'com.advisha.app',
  appName: 'AdviSha',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;

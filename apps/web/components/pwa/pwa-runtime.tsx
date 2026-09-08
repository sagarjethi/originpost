"use client";

import { Download, RefreshCw, WifiOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import styles from "./pwa-runtime.module.css";
import { shouldShowIosInstallHelp } from "./pwa-platform";

type InstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

export function PwaRuntime() {
  const [online, setOnline] = useState(true);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent>();
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker>();
  const [installDismissed, setInstallDismissed] = useState(false);
  const [iosInstallHelp, setIosInstallHelp] = useState(false);
  const reloadForUpdate = useRef(false);

  useEffect(() => {
    setOnline(navigator.onLine);
    setIosInstallHelp(shouldShowIosInstallHelp({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
      standalone: window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
    }));
    const onlineListener = () => setOnline(true);
    const offlineListener = () => setOnline(false);
    const installListener = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
      setInstallDismissed(false);
    };
    const installedListener = () => setInstallPrompt(undefined);
    const controllerListener = () => {
      if (reloadForUpdate.current) window.location.reload();
    };
    window.addEventListener("online", onlineListener);
    window.addEventListener("offline", offlineListener);
    window.addEventListener("beforeinstallprompt", installListener);
    window.addEventListener("appinstalled", installedListener);
    navigator.serviceWorker?.addEventListener("controllerchange", controllerListener);

    if ("serviceWorker" in navigator && window.isSecureContext) {
      void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).then((registration) => {
        if (registration.waiting) setWaitingWorker(registration.waiting);
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          installing?.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) setWaitingWorker(installing);
          });
        });
        void registration.update();
      }).catch(() => {
        // The normal web app remains usable when service workers are disabled by policy.
      });
    }

    return () => {
      window.removeEventListener("online", onlineListener);
      window.removeEventListener("offline", offlineListener);
      window.removeEventListener("beforeinstallprompt", installListener);
      window.removeEventListener("appinstalled", installedListener);
      navigator.serviceWorker?.removeEventListener("controllerchange", controllerListener);
    };
  }, []);

  async function install() {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
    } finally {
      setInstallPrompt(undefined);
    }
  }

  function applyUpdate() {
    if (!waitingWorker) return;
    reloadForUpdate.current = true;
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
  }

  if (!online) {
    return <aside className={`${styles.notice} ${styles.offline}`} role="status" aria-live="polite">
      <span><WifiOff size={17} /></span><div><strong>You are offline</strong><p>Saved newsroom data is not cached. Reconnect to continue safely.</p></div>
    </aside>;
  }
  if (waitingWorker) {
    return <aside className={styles.notice} role="status" aria-live="polite">
      <span><RefreshCw size={17} /></span><div><strong>OriginPost update ready</strong><p>Reload once to use the latest version.</p></div><button type="button" onClick={applyUpdate}>Reload</button>
    </aside>;
  }
  if (installPrompt && !installDismissed) {
    return <aside className={styles.notice} role="status" aria-live="polite">
      <span><Download size={17} /></span><div><strong>Install OriginPost</strong><p>Open the newsroom like an app on this device.</p></div><button type="button" onClick={() => void install()}>Install</button><button className={styles.close} type="button" aria-label="Dismiss install suggestion" onClick={() => setInstallDismissed(true)}><X size={15} /></button>
    </aside>;
  }
  if (iosInstallHelp && !installDismissed) {
    return <aside className={styles.notice} role="status" aria-live="polite">
      <span><Download size={17} /></span><div><strong>Install OriginPost</strong><p>On iPhone or iPad, open Share, then choose Add to Home Screen.</p></div><button className={styles.close} type="button" aria-label="Dismiss install suggestion" onClick={() => setInstallDismissed(true)}><X size={15} /></button>
    </aside>;
  }
  return null;
}

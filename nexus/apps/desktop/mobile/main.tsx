import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles.css";
import { installGlobalErrorReporting } from "@/lib/errors";
import "@/mobile/mobile.css";
import { MobileApp } from "@/mobile/MobileApp";
import { restoreAppearance } from "@/components/Ambient";

restoreAppearance();
installGlobalErrorReporting();
document.documentElement.dataset.platform = "mobile";

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/m/sw.js", { scope: "/m/" }).catch(() => undefined));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
);

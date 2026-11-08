import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { installGlobalErrorReporting } from "./lib/errors";
import { App } from "./app/App";
import { MiniApp } from "./app/MiniApp";
import { windowLabel } from "./lib/tauri";
import { restoreAppearance } from "./components/Ambient";

restoreAppearance();
installGlobalErrorReporting();

const root = createRoot(document.getElementById("root")!);
root.render(<StrictMode>{windowLabel() === "mini" ? <MiniApp /> : <App />}</StrictMode>);

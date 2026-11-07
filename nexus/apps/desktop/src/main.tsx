import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./app/App";
import { MiniApp } from "./app/MiniApp";
import { windowLabel } from "./lib/tauri";

const root = createRoot(document.getElementById("root")!);
root.render(<StrictMode>{windowLabel() === "mini" ? <MiniApp /> : <App />}</StrictMode>);

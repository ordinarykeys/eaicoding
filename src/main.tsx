import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";
import "./index.css";
import "./styles/syntax.css";
import "./styles/epl.css";
import "./styles/harness.css";
import "./styles/settings.css";
import "./styles/composer.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

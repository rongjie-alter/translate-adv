import { render } from "preact";
import { App } from "./ui/App";
import { StoreProvider } from "./ui/store";
import "./ui/app.css";

render(
  <StoreProvider>
    <App />
  </StoreProvider>,
  document.getElementById("app")!,
);

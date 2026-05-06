import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
// Branded ErrorBoundary for a smooth production experience
export function ErrorBoundary() {
  const error = useRouteError();
  console.error("App Error Boundary caught:", error);

  return (
    <div style={{ 
      display: "flex", 
      flexDirection: "column", 
      alignItems: "center", 
      justifyContent: "center", 
      height: "80vh", 
      textAlign: "center",
      padding: "20px",
      fontFamily: "Inter, sans-serif"
    }}>
      <div style={{ fontSize: "64px", marginBottom: "24px" }}>⚠️</div>
      <h1 style={{ fontSize: "24px", fontWeight: "700", color: "#202223", marginBottom: "12px" }}>
        Something went wrong
      </h1>
      <p style={{ fontSize: "16px", color: "#6d7175", maxWidth: "400px", marginBottom: "24px", lineHeight: "1.5" }}>
        We encountered an unexpected error while loading the app. This could be due to a connection issue or a temporary service outage.
      </p>
      <button 
        onClick={() => window.location.reload()}
        style={{
          padding: "12px 24px",
          background: "#008060",
          color: "#fff",
          border: "none",
          borderRadius: "8px",
          fontSize: "15px",
          fontWeight: "600",
          cursor: "pointer",
          boxShadow: "0 2px 4px rgba(0,128,96,0.2)"
        }}
      >
        Refresh Page
      </button>
      <div style={{ marginTop: "32px", fontSize: "12px", color: "#8c9196", background: "#f6f6f7", padding: "12px", borderRadius: "8px", maxWidth: "90%", overflowX: "auto" }}>
        <code>{error?.message || "Unknown error"}</code>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

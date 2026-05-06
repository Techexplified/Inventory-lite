import { useState } from "react";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import inventoryStyles from "../styles/inventory.css?url";

export const links = () => [{ rel: "stylesheet", href: inventoryStyles }];

// ──────────────────────────────────────────────────────────
// Loader
// ──────────────────────────────────────────────────────────
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const [globalSetting, productThresholds] = await Promise.all([
    prisma.thresholdSetting.findUnique({ where: { shop } }),
    prisma.productThreshold.findMany({ where: { shop } }),
  ]);

  const globalThreshold = globalSetting?.threshold ?? 10;
  const productThresholdMap = {};
  productThresholds.forEach((pt) => {
    productThresholdMap[pt.productId] = pt.threshold;
  });

  // Fetch all products for per-product overrides
  const response = await admin.graphql(`
    {
      products(first: 250) {
        edges {
          node {
            id
            title
            status
            featuredImage { url altText }
          }
        }
      }
    }
  `);
  const json = await response.json();
  const products = (json?.data?.products?.edges ?? []).map(({ node }) => ({
    id: node.id,
    title: node.title,
    status: node.status,
    imageUrl: node.featuredImage?.url ?? null,
    imageAlt: node.featuredImage?.altText ?? node.title,
    customThreshold: productThresholdMap[node.id] ?? null,
  }));

  return { globalThreshold, products };
};

// ──────────────────────────────────────────────────────────
// Action
// ──────────────────────────────────────────────────────────
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "save_global") {
    const threshold = parseInt(formData.get("threshold"), 10);
    if (isNaN(threshold) || threshold < 0)
      return { error: "Invalid threshold.", intent };
    await prisma.thresholdSetting.upsert({
      where: { shop },
      update: { threshold },
      create: { shop, threshold },
    });
    return { success: true, intent };
  }

  if (intent === "save_product") {
    const productId = formData.get("productId");
    const raw = formData.get("threshold");
    if (raw === "" || raw === null) {
      // Remove override
      await prisma.productThreshold.deleteMany({ where: { shop, productId } });
      return { success: true, intent, productId, removed: true };
    }
    const threshold = parseInt(raw, 10);
    if (isNaN(threshold) || threshold < 0)
      return { error: "Invalid threshold.", intent, productId };
    await prisma.productThreshold.upsert({
      where: { shop_productId: { shop, productId } },
      update: { threshold },
      create: { shop, productId, threshold },
    });
    return { success: true, intent, productId };
  }

  return { error: "Unknown intent." };
};

// ──────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────
export default function SettingsPage() {
  const { globalThreshold, products } = useLoaderData();
  const fetcher = useFetcher();
  const [globalVal, setGlobalVal] = useState(globalThreshold);
  const [productThresholds, setProductThresholds] = useState(() => {
    const m = {};
    products.forEach((p) => {
      m[p.id] = p.customThreshold !== null ? String(p.customThreshold) : "";
    });
    return m;
  });
  const [savedKeys, setSavedKeys] = useState({});
  const [toast, setToast] = useState(null);

  const showToast = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleSaveGlobal = () => {
    const val = parseInt(globalVal, 10);
    if (isNaN(val) || val < 0) return;
    fetcher.submit({ intent: "save_global", threshold: val }, { method: "POST" });
    showToast(`Global threshold saved: ≤ ${val} units`);
  };

  const handleSaveProduct = (productId) => {
    const val = productThresholds[productId];
    fetcher.submit(
      { intent: "save_product", productId, threshold: val ?? "" },
      { method: "POST" }
    );
    setSavedKeys((prev) => ({ ...prev, [productId]: true }));
    setTimeout(() => setSavedKeys((prev) => ({ ...prev, [productId]: false })), 2000);
    showToast(
      val === "" ? "Product override removed." : `Override saved: ≤ ${val} units`
    );
  };

  return (
    <s-page heading="Threshold Settings">
      <s-section>
        {/* ── Global Threshold ── */}
        <div className="inv-settings-section">
          <div className="inv-settings-section-header">
            <div className="inv-settings-section-title">🔔 Global Alert Threshold</div>
            <div className="inv-settings-section-sub">
              Applies to all products unless overridden below. Products at or
              below this quantity are flagged as Low Stock or Critical.
            </div>
          </div>
          <div className="inv-settings-body">
            <div className="inv-settings-row">
              <div style={{ flex: 1 }}>
                <div className="inv-settings-product-name">Alert when stock drops to or below:</div>
                <div className="inv-settings-product-sku">
                  Critical = ≤ {Math.ceil(parseInt(globalVal) / 2)} &nbsp;|&nbsp;
                  Low = ≤ {globalVal}
                </div>
              </div>
              <div className="inv-settings-threshold-field">
                <input
                  className="inv-settings-input"
                  type="number"
                  min="0"
                  value={globalVal}
                  onChange={(e) => setGlobalVal(e.target.value)}
                  id="global-threshold-settings"
                  aria-label="Global threshold"
                />
                <span style={{ fontSize: 13, color: "#6d7175" }}>units</span>
                <button
                  className="inv-settings-save-btn"
                  onClick={handleSaveGlobal}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ── Per-Product Overrides ── */}
        <div className="inv-settings-section">
          <div className="inv-settings-section-header">
            <div className="inv-settings-section-title">📦 Per-Product Threshold Overrides</div>
            <div className="inv-settings-section-sub">
              Set a custom threshold for specific products. Leave blank to use
              the global threshold. Clear a field and save to remove an override.
            </div>
          </div>
          <div className="inv-settings-body">
            {products.length === 0 ? (
              <div className="inv-empty" style={{ padding: "30px 0" }}>
                <div className="inv-empty-icon">📭</div>
                <div className="inv-empty-title">No products found</div>
                <div className="inv-empty-sub">Add products to your Shopify store first.</div>
              </div>
            ) : (
              products.map((product) => (
                <div key={product.id} className="inv-settings-row">
                  <div className="inv-settings-product">
                    <div className="inv-thumb" style={{ width: 36, height: 36, borderRadius: 6 }}>
                      {product.imageUrl ? (
                        <img src={product.imageUrl} alt={product.imageAlt} />
                      ) : (
                        <span style={{ fontSize: 16 }}>📦</span>
                      )}
                    </div>
                    <div>
                      <div className="inv-settings-product-name">{product.title}</div>
                      <div className="inv-settings-product-sku">
                        {product.status !== "ACTIVE" ? `Draft` : "Active"}
                        {productThresholds[product.id] === ""
                          ? ` · Using global (≤ ${globalVal})`
                          : productThresholds[product.id]
                          ? ` · Override: ≤ ${productThresholds[product.id]} units`
                          : ` · Using global (≤ ${globalVal})`}
                      </div>
                    </div>
                  </div>
                  <div className="inv-settings-threshold-field">
                    <input
                      className="inv-settings-input"
                      type="number"
                      min="0"
                      placeholder={`${globalVal}`}
                      value={productThresholds[product.id] ?? ""}
                      onChange={(e) =>
                        setProductThresholds((prev) => ({
                          ...prev,
                          [product.id]: e.target.value,
                        }))
                      }
                      aria-label={`Threshold for ${product.title}`}
                    />
                    <span style={{ fontSize: 13, color: "#6d7175" }}>units</span>
                    <button
                      className="inv-settings-save-btn"
                      onClick={() => handleSaveProduct(product.id)}
                      style={savedKeys[product.id] ? { background: "#007f5f" } : {}}
                    >
                      {savedKeys[product.id] ? "✓ Saved" : "Save"}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </s-section>

      {/* ── Toast ── */}
      {toast && <div className={`inv-toast ${toast.type}`}>{toast.msg}</div>}
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);

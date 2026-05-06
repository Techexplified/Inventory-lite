import { useState, useCallback, useEffect, useMemo } from "react";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import inventoryStyles from "../styles/inventory.css?url";

// ──────────────────────────────────────────────────────────
// CSS link
// ──────────────────────────────────────────────────────────
export const links = () => [{ rel: "stylesheet", href: inventoryStyles }];

// ──────────────────────────────────────────────────────────
// Helper: classify status
// ──────────────────────────────────────────────────────────
function getStatus(qty, threshold) {
  if (qty === null || qty === undefined) return "unknown";
  if (qty === 0) return "out_of_stock";
  if (qty <= Math.ceil(threshold / 2)) return "critical";
  if (qty <= threshold) return "low";
  return "healthy";
}

// ──────────────────────────────────────────────────────────
// Loader – fetch products + inventory + thresholds
// ──────────────────────────────────────────────────────────
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // Load thresholds from DB
  const [globalSetting, productThresholds] = await Promise.all([
    prisma.thresholdSetting.findUnique({ where: { shop } }),
    prisma.productThreshold.findMany({ where: { shop } }),
  ]);

  const globalThreshold = globalSetting?.threshold ?? 10;
  const productThresholdMap = {};
  productThresholds.forEach((pt) => {
    productThresholdMap[pt.productId] = pt.threshold;
  });

  // Fetch products from Shopify GraphQL
  let rows = [];
  let summary = null;
  let locationId = null;
  let fetchError = null;

  try {
    const response = await admin.graphql(`
      {
        products(first: 250) {
          edges {
            node {
              id
              title
              status
              productType
              featuredImage {
                url
                altText
              }
              variants(first: 10) {
                edges {
                  node {
                    id
                    sku
                    inventoryQuantity
                    displayName
                    inventoryItem {
                      id
                      tracked
                      inventoryLevels(first: 5) {
                        edges {
                          node {
                            location { id name }
                            quantities(names: ["available"]) {
                              name
                              quantity
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `);

    const json = await response.json();

    if (json.errors) {
      const isAccessDenied = json.errors.some(err =>
        err.message.toLowerCase().includes("access denied")
      );
      fetchError = isAccessDenied
        ? "Access denied. Please check your app permissions (scopes)."
        : json.errors[0].message;
    } else {
      const rawProducts = json?.data?.products?.edges ?? [];

      rawProducts.forEach(({ node: product }) => {
        product.variants.edges.forEach(({ node: variant }) => {
          const inventoryLevels = variant.inventoryItem?.inventoryLevels?.edges ?? [];

          // Pick the level with the most available stock; fall back to first level
          const bestLevel = inventoryLevels
            .map(e => e.node)
            .sort((a, b) => {
              const qtyA = a.quantities?.find(q => q.name === "available")?.quantity ?? 0;
              const qtyB = b.quantities?.find(q => q.name === "available")?.quantity ?? 0;
              return qtyB - qtyA;
            })[0] ?? null;

          const variantLocationId = bestLevel?.location?.id ?? null;
          const levelQty = bestLevel?.quantities?.find(q => q.name === "available")?.quantity ?? null;

          const qty =
            variant.inventoryItem?.tracked === false
              ? null
              : (levelQty ?? variant.inventoryQuantity ?? null);

          // Track the global locationId (first one found)
          if (!locationId && variantLocationId) locationId = variantLocationId;

          const effectiveThreshold =
            productThresholdMap[product.id] ?? globalThreshold;
          const status = getStatus(qty, effectiveThreshold);

          rows.push({
            productId: product.id,
            variantId: variant.id,
            inventoryItemId: variant.inventoryItem?.id ?? null,
            locationId: variantLocationId,  // per-variant location
            productTitle: product.title,
            variantName:
              variant.displayName === product.title ? null : variant.displayName,
            category: product.productType || "—",
            sku: variant.sku || null,
            imageUrl: product.featuredImage?.url ?? null,
            imageAlt: product.featuredImage?.altText ?? product.title,
            qty,
            status,
            productStatus: product.status,
            effectiveThreshold,
            tracked: variant.inventoryItem?.tracked !== false,
          });
        });
      });

      summary = {
        all: rows.length,
        critical: rows.filter((r) => r.status === "critical").length,
        low: rows.filter((r) => r.status === "low").length,
        out_of_stock: rows.filter((r) => r.status === "out_of_stock").length,
        healthy: rows.filter((r) => r.status === "healthy").length,
      };
    }
  } catch (err) {
    console.error("GraphQL Loader Error:", err);
    fetchError = "Failed to fetch data from Shopify. " + (err?.message ?? "");
  }

  return { globalThreshold, rows, summary, locationId, fetchError };
};

// ──────────────────────────────────────────────────────────
// Action – handle threshold save + stock update
// ──────────────────────────────────────────────────────────
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "save_threshold") {
    const threshold = parseInt(formData.get("threshold"), 10);
    if (isNaN(threshold) || threshold < 0) {
      return { error: "Invalid threshold value." };
    }
    await prisma.thresholdSetting.upsert({
      where: { shop },
      update: { threshold },
      create: { shop, threshold },
    });
    return { success: true, intent };
  }

  if (intent === "save_product_threshold") {
    const productId = formData.get("productId");
    const raw = formData.get("threshold");
    if (raw === "" || raw === null) {
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
    return { success: true, intent, productId, threshold };
  }

  if (intent === "update_stock") {
    const inventoryItemId = formData.get("inventoryItemId");
    const newQty = parseInt(formData.get("newQty"), 10);
    const locationId = formData.get("locationId");

    if (isNaN(newQty) || newQty < 0) {
      return { error: "Stock must be 0 or a positive number." };
    }

    if (!locationId) {
      return { error: "No location found. Please ensure your store has at least one location with inventory tracking enabled." };
    }

    console.log(`[update_stock] inventoryItemId=${inventoryItemId} locationId=${locationId} newQty=${newQty}`);

    const setResult = await admin.graphql(
      `
      mutation setInventory($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          inventoryAdjustmentGroup {
            reason
          }
          userErrors { field message }
        }
      }
    `,
      {
        variables: {
          input: {
            name: "available",
            reason: "correction",
            ignoreCompareQuantity: true,
            quantities: [
              {
                inventoryItemId,
                locationId,
                quantity: newQty,
              },
            ],
          },
        },
      }
    );

    const setJson = await setResult.json();
    console.log(`[update_stock] Shopify response:`, JSON.stringify(setJson));

    // Check top-level GraphQL errors
    if (setJson.errors?.length > 0) {
      console.error("[update_stock] GraphQL errors:", setJson.errors);
      return { error: setJson.errors[0].message };
    }

    const userErrors = setJson?.data?.inventorySetQuantities?.userErrors ?? [];
    if (userErrors.length > 0) {
      console.error("[update_stock] userErrors:", userErrors);
      return { error: userErrors[0].message };
    }

    if (!setJson?.data?.inventorySetQuantities?.inventoryAdjustmentGroup) {
      console.warn("[update_stock] No adjustment group returned — update may not have applied.");
      return { error: "Shopify did not confirm the inventory update. The item may not be stocked at this location." };
    }

    console.log(`[update_stock] ✅ Success — set ${inventoryItemId} to ${newQty} at ${locationId}`);
    return { success: true, intent, newQty };
  }

  return { error: "Unknown action." };
};

// ──────────────────────────────────────────────────────────
// Status helpers
// ──────────────────────────────────────────────────────────
const STATUS_LABEL = {
  critical: "Critical",
  low: "Low Stock",
  healthy: "Healthy",
  out_of_stock: "Out of Stock",
  unknown: "Unknown",
};

// ──────────────────────────────────────────────────────────
// Component: UpdateStockModal
// ──────────────────────────────────────────────────────────
function UpdateStockModal({ row, onClose, globalThreshold }) {
  const fetcher = useFetcher();
  const thresholdFetcher = useFetcher();
  const [qty, setQty] = useState(row.qty ?? 0);
  const [inputError, setInputError] = useState("");
  const [isSuccess, setIsSuccess] = useState(false);
  const [successData, setSuccessData] = useState(null);
  const [customThreshold, setCustomThreshold] = useState(
    row.effectiveThreshold !== globalThreshold ? String(row.effectiveThreshold) : ""
  );
  const [thresholdSaved, setThresholdSaved] = useState(false);

  const isSubmitting =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "update_stock";
  const isSavingThreshold =
    thresholdFetcher.state !== "idle";

  useEffect(() => {
    const isDone = fetcher.state === "idle" && fetcher.data?.intent === "update_stock";
    if (isDone && fetcher.data?.success && !isSuccess) {
      setIsSuccess(true);
      setSuccessData({
        previousQty: row.qty ?? 0,
        newQty: fetcher.data.newQty,
      });
    }
  }, [fetcher.state, fetcher.data, isSuccess, row.qty]);

  const handleSaveThreshold = () => {
    thresholdFetcher.submit(
      { intent: "save_product_threshold", productId: row.productId, threshold: customThreshold },
      { method: "POST" }
    );
    setThresholdSaved(true);
    setTimeout(() => setThresholdSaved(false), 2000);
  };

  const handleChange = (val) => {
    const n = parseInt(val, 10);
    if (val === "" || isNaN(n)) {
      setInputError("Please enter a valid number.");
      setQty(val);
    } else if (n < 0) {
      setInputError("Stock cannot be negative.");
      setQty(val);
    } else {
      setInputError("");
      setQty(n);
    }
  };

  const handleSave = () => {
    const n = parseInt(qty, 10);
    if (isNaN(n) || n < 0) {
      setInputError("Stock must be 0 or a positive number.");
      return;
    }
    if (!row.locationId) {
      setInputError("No inventory location found for this product. Enable inventory tracking in Shopify.");
      return;
    }
    fetcher.submit(
      {
        intent: "update_stock",
        inventoryItemId: row.inventoryItemId,
        locationId: row.locationId,
        newQty: n,
        currentQty: row.qty ?? 0,
      },
      { method: "POST" }
    );
  };

  // Success state render
  if (isSuccess && successData) {
    const diff = successData.newQty - successData.previousQty;
    const diffText = diff >= 0 ? `+${Math.abs(diff)} units added` : `${Math.abs(diff)} units removed`;

    return (
      <div className="inv-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose(successData.newQty)}>
        <div className="inv-modal" style={{ textAlign: "center" }}>
          <div className="inv-modal-header" style={{ borderBottom: "none", paddingBottom: 0 }}>
            <div />
            <button className="inv-modal-close" onClick={() => onClose(successData.newQty)} aria-label="Close">
              ✕
            </button>
          </div>

          <div className="inv-modal-success-body">
            <div className="inv-success-icon" style={{ position: "relative" }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M20 6L9 17L4 12" stroke="#099268" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {/* Sparkles */}
              {[...Array(6)].map((_, i) => (
                <div 
                  key={i} 
                  className="inv-success-sparkle" 
                  style={{ 
                    '--tx': `${(Math.random() - 0.5) * 100}px`, 
                    '--ty': `${(Math.random() - 0.5) * 100}px`,
                    left: '50%',
                    top: '50%'
                  }} 
                />
              ))}
            </div>
            <h2 className="inv-success-title">Stock Updated!</h2>
            <p className="inv-success-subtitle">
              <strong>{row.productTitle}</strong> inventory has been successfully synced.
            </p>

            <div style={{ margin: "20px 0" }}>
              <div className="inv-success-tag">
                <svg width="14" height="14" viewBox="0 0 20 20" fill="none" style={{ marginRight: 6 }}>
                  {diff >= 0 ? (
                    <path d="M14.5 13L10 8.5L5.5 13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  ) : (
                    <path d="M5.5 8L10 12.5L14.5 8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  )}
                </svg>
                {diffText}
              </div>
            </div>

            <div className="inv-success-meta">
              <span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#099268" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>
                </svg>
                Synced with Shopify
              </span>
              <span>{successData.previousQty} → {successData.newQty}</span>
            </div>
          </div>

          <div className="inv-modal-footer" style={{ background: "transparent", padding: "0 32px 32px" }}>
            <button
              className="inv-btn-primary"
              style={{ width: "100%" }}
              onClick={() => onClose(successData.newQty)}
            >
              ✓ Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="inv-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose(null)}>
      <div className="inv-modal">
        <div className="inv-modal-header">
          <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
            <div className="inv-thumb" style={{ width: 64, height: 64, borderRadius: 14 }}>
              {row.imageUrl ? (
                <img src={row.imageUrl} alt={row.imageAlt} />
              ) : (
                <span className="inv-thumb-placeholder">📦</span>
              )}
            </div>
            <div>
              <div className="inv-modal-title">
                {row.productTitle}
                {row.variantName ? ` – ${row.variantName}` : ""}
              </div>
              <div className="inv-modal-subtitle">
                <span style={{ fontFamily: "monospace", opacity: 0.8 }}>
                  {row.sku || "NO SKU"}
                </span>
              </div>
            </div>
          </div>
          <button className="inv-modal-close" onClick={() => onClose(null)} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="inv-modal-body">
          <label className="inv-modal-label">New Inventory Quantity</label>
          <div className="inv-stepper">
            <button
              className="inv-stepper-btn"
              disabled={parseInt(qty, 10) <= 0}
              onClick={() => handleChange(Math.max(0, parseInt(qty, 10) || 0) - 1)}
            >
              −
            </button>
            <input
              className={`inv-stepper-input ${parseInt(qty, 10) < 0 ? 'error' : ''}`}
              type="number"
              value={qty}
              onChange={(e) => handleChange(e.target.value)}
            />
            <button
              className="inv-stepper-btn"
              onClick={() => handleChange((parseInt(qty, 10) || 0) + 1)}
            >
              +
            </button>
          </div>
          {inputError && (
            <div className="inv-modal-error">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 20c5.523 0 10-4.477 10-10S15.523 0 10 0 0 4.477 0 10s4.477 10 10 10zm0-18c4.411 0 8 3.589 8 8s-3.589 8-8 8-8-3.589-8-8 3.589-8 8-8zm1 5v5H9V7h2zm0 8v-2H9v2h2z" clipRule="evenodd" />
              </svg>
              {inputError}
            </div>
          )}
          {fetcher.data?.error && (
            <div className="inv-modal-error">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 20c5.523 0 10-4.477 10-10S15.523 0 10 0 0 4.477 0 10s4.477 10 10 10zm0-18c4.411 0 8 3.589 8 8s-3.589 8-8 8-8-3.589-8-8 3.589-8 8-8zm1 5v5H9V7h2zm0 8v-2H9v2h2z" clipRule="evenodd" />
              </svg>
              {fetcher.data.error}
            </div>
          )}
          {!row.tracked && (
            <div className="inv-modal-error" style={{ background: "#f6f6f7", color: "#6d7175", borderColor: "#e1e3e5", marginTop: 10 }}>
              ℹ Inventory tracking is disabled for this variant.
            </div>
          )}

          {/* ── Per-product Threshold Override ── */}
          <div className="inv-modal-threshold-section">
            <div className="inv-modal-threshold-label">
              <span>🔔</span>
              <div>
                <strong>Alert Threshold Override</strong>
                <span>Custom alert level for this product. Leave blank to use global ({globalThreshold} units).</span>
              </div>
            </div>
            <div className="inv-modal-threshold-controls">
              <input
                className="inv-settings-input"
                type="number"
                min="0"
                placeholder={`${globalThreshold}`}
                value={customThreshold}
                onChange={(e) => setCustomThreshold(e.target.value)}
                aria-label="Custom threshold for this product"
              />
              <span style={{ fontSize: 12, color: "#6d7175" }}>units</span>
              <button
                className="inv-settings-save-btn"
                onClick={handleSaveThreshold}
                disabled={isSavingThreshold}
                style={thresholdSaved ? { background: "#007f5f" } : {}}
              >
                {thresholdSaved ? "✓ Saved" : isSavingThreshold ? "…" : "Set"}
              </button>
            </div>
          </div>
        </div>

        <div className="inv-modal-footer">
          <button className="inv-btn-secondary" onClick={() => onClose(null)}>
            Cancel
          </button>
          <button
            className="inv-btn-primary"
            onClick={handleSave}
            disabled={isSubmitting || !!inputError || !row.tracked}
          >
            {isSubmitting ? "Saving…" : "Save Stock"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Main Dashboard Component
// ──────────────────────────────────────────────────────────
function recalcSummary(rows) {
  return {
    all: rows.length,
    critical: rows.filter((r) => r.status === "critical").length,
    low: rows.filter((r) => r.status === "low").length,
    out_of_stock: rows.filter((r) => r.status === "out_of_stock").length,
    healthy: rows.filter((r) => r.status === "healthy").length,
  };
}

function InventoryDashboardInner({ initialRows, initialSummary, globalThreshold }) {
  const thresholdFetcher = useFetcher();

  const [rows, setRows] = useState(initialRows);
  const [summary, setSummary] = useState(initialSummary);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [threshold, setThreshold] = useState(globalThreshold);
  const [modalRow, setModalRow] = useState(null);
  const [toast, setToast] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 10;

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [filter, search, categoryFilter]);

  const showToast = useCallback((msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // Save global threshold AND recategorize rows immediately
  const handleSaveThreshold = () => {
    const val = parseInt(threshold, 10);
    if (isNaN(val) || val < 0) return;
    thresholdFetcher.submit(
      { intent: "save_threshold", threshold: val },
      { method: "POST" }
    );
    // Recategorize rows that use the global threshold
    setRows((prev) => {
      const updated = prev.map((r) => {
        // Only update rows that haven't been individually overridden
        // (effectiveThreshold === old global means it was using global)
        const newEffective = r.effectiveThreshold === globalThreshold ? val : r.effectiveThreshold;
        return { ...r, effectiveThreshold: newEffective, status: getStatus(r.qty, newEffective) };
      });
      setSummary(recalcSummary(updated));
      return updated;
    });
    showToast(`Alert threshold set to ${val} units.`);
  };

  // Modal close handler — update rows in place (single pass, no stale-state bug)
  const handleModalClose = (newQty, updatedThreshold) => {
    if (newQty !== null && modalRow) {
      setRows((prev) => {
        const updated = prev.map((r) => {
          if (r.variantId === modalRow.variantId) {
            const effectiveThreshold = updatedThreshold ?? r.effectiveThreshold;
            const updatedStatus = getStatus(newQty, effectiveThreshold);
            return { ...r, qty: newQty, status: updatedStatus, effectiveThreshold };
          }
          return r;
        });
        setSummary(recalcSummary(updated));
        return updated;
      });
      showToast("Stock updated successfully!");
    }
    setModalRow(null);
  };

  // Filter + search rows
  const categories = useMemo(() => {
    return ["all", ...new Set(rows.map(r => r.category).filter(c => c && c !== "—"))].sort();
  }, [rows]);

  const displayedRows = useMemo(() => {
    return rows.filter((row) => {
      const matchesFilter =
        filter === "all" ||
        row.status === filter ||
        (filter === "low_and_critical" && (row.status === "low" || row.status === "critical"));

      const matchesCategory = categoryFilter === "all" || row.category === categoryFilter;

      const searchLower = search.toLowerCase();
      const matchesSearch =
        !search ||
        row.productTitle.toLowerCase().includes(searchLower) ||
        (row.sku || "").toLowerCase().includes(searchLower) ||
        (row.variantName || "").toLowerCase().includes(searchLower);

      return matchesFilter && matchesCategory && matchesSearch;
    });
  }, [rows, filter, categoryFilter, search]);

  const totalPages = useMemo(() => Math.ceil(displayedRows.length / ITEMS_PER_PAGE), [displayedRows]);

  const paginatedRows = useMemo(() => {
    return displayedRows.slice(
      (currentPage - 1) * ITEMS_PER_PAGE,
      currentPage * ITEMS_PER_PAGE
    );
  }, [displayedRows, currentPage]);

  const isSavingThreshold =
    thresholdFetcher.state !== "idle" &&
    thresholdFetcher.formData?.get("intent") === "save_threshold";

  const handleExportPDF = () => {
    const doc = new jsPDF();
    doc.text("Inventory Alert Lite - Stock Report", 14, 15);

    const tableData = displayedRows.map((row, idx) => [
      idx + 1,
      row.productTitle + (row.variantName ? ` - ${row.variantName}` : ""),
      row.category,
      row.sku || "N/A",
      row.qty !== null ? row.qty : "N/A",
      STATUS_LABEL[row.status] ?? row.status,
      `<= ${row.effectiveThreshold}`
    ]);

    autoTable(doc, {
      head: [["#", "Product", "Category", "SKU", "Stock", "Status", "Threshold"]],
      body: tableData,
      startY: 20,
    });

    doc.save("inventory-report.pdf");
    showToast("PDF exported successfully!");
  };

  return (
    <s-page heading="Inventory Alert Lite">
      <div className="inv-dashboard">
        {/* ── Threshold Card ── */}
        <s-section>
        <div className="inv-threshold-card">
          <span className="inv-threshold-icon">🔔</span>
          <div className="inv-threshold-text">
            <strong>Global Alert Threshold</strong>
            <span>Products at or below this quantity will be flagged as Low Stock or Critical.</span>
          </div>
          <div className="inv-threshold-controls">
            <input
              className="inv-threshold-input"
              type="number"
              min="0"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              id="global-threshold"
              aria-label="Global threshold units"
            />
            <button
              className={`inv-threshold-save${isSavingThreshold ? " saving" : ""}`}
              onClick={handleSaveThreshold}
              disabled={isSavingThreshold}
            >
              {isSavingThreshold ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        {/* ── Summary Cards ── */}
        <div className="inv-summary-grid">
          {[
            { 
              key: "all", 
              label: "All Products", 
              count: summary.all, 
              colorClass: "all", 
              icon: (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                  <path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" />
                </svg>
              ) 
            },
            { 
              key: "out_of_stock", 
              label: "Out of Stock", 
              count: summary.out_of_stock, 
              colorClass: "critical", 
              icon: (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                </svg>
              ) 
            },
            { 
              key: "critical", 
              label: "Critical", 
              count: summary.critical, 
              colorClass: "critical", 
              icon: (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ff1f1f" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              ) 
            },
            { 
              key: "low", 
              label: "Low Stock", 
              count: summary.low, 
              colorClass: "low", 
              icon: (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              ) 
            },
            { 
              key: "healthy", 
              label: "Healthy", 
              count: summary.healthy, 
              colorClass: "healthy", 
              icon: (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              ) 
            },
          ].map(({ key, label, count, colorClass, icon }) => (
            <div
              key={key}
              className={`inv-summary-card ${filter === key ? `active active-${colorClass}` : ""}`}
              onClick={() => setFilter(filter === key ? "all" : key)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && setFilter(filter === key ? "all" : key)}
              aria-label={`Filter by ${label}`}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "4px" }}>
                <span className="inv-card-label">{label}</span>
                <span style={{ fontSize: "16px" }}>{icon}</span>
              </div>
              <span className={`inv-card-count ${colorClass}`}>{count}</span>
            </div>
          ))}
        </div>

        {/* ── Toolbar ── */}
        <div className="inv-toolbar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: "12px", flex: 1, minWidth: "280px" }}>
            <div className="inv-search-wrap" style={{ flex: 1 }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="2" />
                <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <input
                className="inv-search"
                type="text"
                placeholder="Search by product name or SKU…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                id="inv-search-input"
                aria-label="Search products"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  style={{ position: "absolute", right: "10px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#adb5bd", fontSize: "18px" }}
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
            <select
              className="inv-search"
              style={{ width: "auto", paddingLeft: "12px", paddingRight: "30px", cursor: "pointer", appearance: "auto", maxWidth: "200px", color: "#202223" }}
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              aria-label="Filter by Category"
            >
              <option value="all">All Categories</option>
              {categories.filter(c => c !== "all").map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <button
            className="inv-action-btn"
            onClick={() => {
              window.location.reload();
            }}
            style={{ display: "flex", alignItems: "center", gap: "6px" }}
            title="Refresh data"
          >
            <span style={{ fontSize: "16px" }}>🔄</span>
            Refresh
          </button>
          <button
            className="inv-action-btn"
            onClick={handleExportPDF}
            style={{ display: "flex", alignItems: "center", gap: "6px" }}
            title="Download PDF report"
          >
            <span style={{ fontSize: "16px" }}>📄</span>
            Export Report
          </button>
        </div>

        {/* ── Table ── */}
        <div className="inv-table-wrap">
          {displayedRows.length === 0 ? (
            <div className="inv-empty">
              <span className="inv-empty-icon">🔍</span>
              <strong className="inv-empty-title">No matching products found</strong>
              <p className="inv-empty-sub">Try adjusting your search terms or filters to see more results.</p>
              {(search || filter !== "all" || categoryFilter !== "all") && (
                <button
                  className="inv-action-btn"
                  style={{ marginTop: "16px", borderColor: "#099268", color: "#099268", fontWeight: "700" }}
                  onClick={() => {
                    setSearch("");
                    setFilter("all");
                    setCategoryFilter("all");
                  }}
                >
                  Clear all filters
                </button>
              )}
            </div>
          ) : (
            <div className="inv-table-scroll">
              <table className="inv-table" aria-label="Inventory Status Table">
                <thead>
                  <tr>
                    <th style={{ width: 56 }}>#</th>
                    <th>Product</th>
                    <th>Category</th>
                    <th>SKU</th>
                    <th>Stock</th>
                    <th>Status</th>
                    <th>Threshold</th>
                    <th style={{ width: 110 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedRows.map((row, idx) => (
                    <tr key={row.variantId} onClick={() => row.tracked && setModalRow(row)}>
                      <td style={{ color: "#8c9196", fontWeight: 500 }}>
                        {(currentPage - 1) * ITEMS_PER_PAGE + idx + 1}
                      </td>

                      {/* Product cell */}
                      <td>
                        <div className="inv-product-cell">
                          <div className="inv-thumb">
                            {row.imageUrl ? (
                              <img src={row.imageUrl} alt={row.imageAlt} />
                            ) : (
                              <span className="inv-thumb-placeholder">📦</span>
                            )}
                          </div>
                          <div className="inv-product-info">
                            <span className="inv-product-name">{row.productTitle}</span>
                            {row.variantName && (
                              <span className="inv-product-sku">{row.variantName}</span>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Category */}
                      <td>
                        <span style={{ color: "#6d7175", fontSize: 13, whiteSpace: "nowrap" }}>
                          {row.category}
                        </span>
                      </td>

                      {/* SKU */}
                      <td>
                        <span style={{ color: "#6d7175", fontFamily: "monospace", fontSize: 13, whiteSpace: "nowrap" }}>
                          {row.sku || "—"}
                        </span>
                      </td>

                      {/* Stock */}
                      <td>
                        {row.qty === null ? (
                          <span style={{ color: "#8c9196" }}>N/A</span>
                        ) : (
                          <span className={`inv-stock-count ${row.status === "out_of_stock" ? "critical" : row.status}`}>
                            {row.qty}
                          </span>
                        )}
                      </td>

                      {/* Status badge */}
                      <td>
                        <span className={`inv-badge ${row.status}`}>
                          {STATUS_LABEL[row.status] ?? row.status}
                        </span>
                      </td>

                      {/* Threshold */}
                      <td>
                        <span style={{ color: "#6d7175", fontSize: 13 }}>
                          ≤ {row.effectiveThreshold} units
                        </span>
                      </td>

                      {/* Action */}
                      <td>
                        <button
                          className="inv-action-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (row.tracked) setModalRow(row);
                          }}
                          disabled={!row.tracked}
                          title={!row.tracked ? "Inventory tracking disabled" : "Update stock"}
                        >
                          Update Stock
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination Controls */}
          {displayedRows.length > 0 && (
            <div className="inv-pagination">
              <span className="inv-pagination-info">
                Showing {(currentPage - 1) * ITEMS_PER_PAGE + 1} – {Math.min(currentPage * ITEMS_PER_PAGE, displayedRows.length)} of {displayedRows.length} variants
              </span>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  className="inv-pagination-btn"
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                    <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Previous
                </button>
                <button
                  className="inv-pagination-btn"
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                >
                  Next
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                    <path d="M7.5 5L12.5 10L7.5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>
      </s-section>

      {/* ── Update Stock Modal ── */}
      {modalRow && (
        <UpdateStockModal row={modalRow} onClose={handleModalClose} globalThreshold={threshold} />
      )}

      {/* ── Toast ── */}
      {toast && (
        <div className={`inv-toast ${toast.type}`}>{toast.msg}</div>
      )}
      </div>
    </s-page>
  );
}

export default function InventoryDashboard() {
  const { globalThreshold, rows, summary, fetchError } = useLoaderData();

  if (fetchError) {
    return (
      <s-page heading="Inventory Alert Lite">
        <s-section>
          <div className="inv-empty" style={{ padding: "60px 20px" }}>
            <div className="inv-empty-icon">⚠️</div>
            <div className="inv-empty-title">Something went wrong</div>
            <div className="inv-empty-sub" style={{ color: "#d72c0d", fontWeight: "bold" }}>
              {fetchError}
            </div>
            {fetchError.includes("permissions") && (
              <div style={{ marginTop: "20px" }}>
                <p>Try refreshing the page or running the app again to trigger a permission request.</p>
              </div>
            )}
          </div>
        </s-section>
      </s-page>
    );
  }

  return (
    <InventoryDashboardInner
      initialRows={rows}
      initialSummary={summary}
      globalThreshold={globalThreshold}
    />
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);

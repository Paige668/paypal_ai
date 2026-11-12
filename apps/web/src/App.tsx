import { useEffect, useMemo, useRef, useState } from "react";
import {
  amountValidationMessage,
  demoActionHint,
  eventTitle,
  formatTime,
  friendlyError,
  graceSecondsRemaining,
  provenance,
  workflowStage
} from "./presentation";
import { clearCurrentOrderId, readCurrentOrderId, storeCurrentOrderId } from "./workspace";
import type {
  Investigation,
  Order,
  PaymentEvent,
  PublicConfig,
  Reconciliation,
  Scenario,
  Timeline
} from "./types";

class ApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "ApiError";
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  const body = await response.json().catch(() => ({ error: "INVALID_SERVER_RESPONSE" })) as { error?: string };
  if (!response.ok) throw new ApiError(body.error ?? "REQUEST_FAILED", response.status);
  return body as T;
}

function loadPayPalSdk(clientId: string, currency: string): Promise<void> {
  if (window.paypal) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>("script[data-paypal-sdk]");
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => {
        existing.remove();
        reject(new Error("PayPal SDK failed to load"));
      }, { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.dataset.paypalSdk = "true";
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(currency)}&intent=capture`;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(new Error("PayPal SDK failed to load"));
    };
    document.head.appendChild(script);
  });
}

function EvidenceLinks({ ids }: { ids: string[] }) {
  if (!ids.length) return <span className="no-citation">No evidence reference required</span>;
  const reveal = (evidenceId: string) => {
    const element = document.getElementById(`evidence-${evidenceId}`);
    const disclosure = element?.querySelector<HTMLDetailsElement>("details.event-disclosure");
    if (disclosure) disclosure.open = true;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    element?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    element?.focus({ preventScroll: true });
    element?.classList.remove("evidence-highlight");
    window.requestAnimationFrame(() => element?.classList.add("evidence-highlight"));
    window.setTimeout(() => element?.classList.remove("evidence-highlight"), 1_600);
  };
  return (
    <span className="evidence-links" aria-label="Evidence references">
      {ids.map((id, index) => <button type="button" className="evidence-link" key={id} title={id} aria-label={`Open evidence ${id}`} onClick={() => reveal(id)}>Evidence {String(index + 1).padStart(2, "0")}</button>)}
    </span>
  );
}

function StateCard({ eyebrow, value, detail, tone }: { eyebrow: string; value: string; detail: string; tone: string }) {
  return (
    <article className={`state-card ${tone}`}>
      <p>{eyebrow}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}

function TimelineEvent({ event, index }: { event: PaymentEvent; index: number }) {
  const source = provenance[event.source];
  return (
    <li id={`evidence-${event.evidenceId}`} className="timeline-event" tabIndex={-1}>
      <div className="timeline-marker" aria-hidden="true">{String(index + 1).padStart(2, "0")}</div>
      <div className="timeline-body">
        <div className="timeline-heading">
          <span className={`source-badge ${source.tone}`}>{source.label}</span>
          <time dateTime={event.observedAt}>{formatTime(event.observedAt)}</time>
        </div>
        <h3>{eventTitle(event.kind)}</h3>
        <details className="event-disclosure">
          <summary>Evidence details</summary>
          <div className="event-detail-content">
            <p className="evidence-id">{event.evidenceId}</p>
            <div className="event-summary">
              {Object.entries(event.summary).map(([key, value]) => (
                <span key={key}><b>{eventTitle(key)}</b>{value}</span>
              ))}
            </div>
            <p className="verification">Verification · {event.verificationStatus.replaceAll("_", " ")}</p>
          </div>
        </details>
      </div>
    </li>
  );
}

function InvestigationPanel({ investigation }: { investigation: Investigation }) {
  const isAi = investigation.status === "AI_GENERATED";
  const primaryHypothesis = investigation.report.hypotheses.find((item) => item.confidence === "likely")
    ?? investigation.report.hypotheses[0];
  const diagnosis = primaryHypothesis?.statement ?? investigation.report.summary;
  const diagnosisEvidence = primaryHypothesis?.evidenceIds ?? investigation.report.facts.flatMap((item) => item.evidenceIds);
  const confidence = primaryHypothesis?.confidence === "likely"
    ? "High confidence"
    : primaryHypothesis?.confidence === "possible" ? "Moderate confidence" : "Evidence-confirmed mismatch";
  const primaryAction = investigation.report.nextSteps[0];
  const reasoningFacts = investigation.report.facts.slice(0, 3);
  const materialUnknowns = investigation.report.unknowns.slice(0, 3);
  const secondaryActions = investigation.report.nextSteps.slice(1, 3);
  const alternativeHypotheses = investigation.report.hypotheses.filter((item) => item !== primaryHypothesis).slice(0, 2);
  return (
    <section id="investigation-report" className="report-section" aria-labelledby="report-heading" tabIndex={-1}>
      <div className="section-heading">
        <div>
          <p className="section-kicker">04 · Investigate</p>
          <h2 id="report-heading">Incident decision brief</h2>
        </div>
        <span className={`source-badge ${isAi ? "ai" : "fallback"}`}>{investigation.report.label}</span>
      </div>
      <div className="report-meta">
        <span>{investigation.model ?? "Deterministic fallback"}</span>
        <span>{formatTime(investigation.generatedAt)}</span>
        {investigation.failureCode && <span>{investigation.failureCode.replaceAll("_", " ")}</span>}
      </div>
      <article className="diagnosis-card">
        <div className="diagnosis-label-row">
          <span className="diagnosis-label">Primary diagnosis</span>
          <span className="diagnosis-confidence"><i aria-hidden="true" />{confidence}</span>
        </div>
        <h3>{diagnosis}</h3>
        {diagnosis !== investigation.report.summary && <p>{investigation.report.summary}</p>}
        <EvidenceLinks ids={[...new Set(diagnosisEvidence)]} />
      </article>

      <div className="decision-grid">
        <article className="reasoning-panel">
          <p className="decision-kicker">Why this is the leading diagnosis</p>
          <ol className="reasoning-chain">
            {reasoningFacts.length ? reasoningFacts.map((item, index) => (
              <li key={`${item.statement}-${index}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div><p>{item.statement}</p><EvidenceLinks ids={item.evidenceIds} /></div>
              </li>
            )) : <li className="empty-copy">No confirmed facts were returned.</li>}
          </ol>
        </article>

        <article className="action-panel">
          <div className="action-priority">Do this first</div>
          {primaryAction ? <>
            <h3>{primaryAction.action}</h3>
            <p>{primaryAction.reason}</p>
            <EvidenceLinks ids={primaryAction.evidenceIds} />
          </> : <p className="empty-copy">No safe inspection step was returned.</p>}
        </article>
      </div>

      <details className="judgment-boundary">
        <summary><span>What could change this judgment?</span><span>{materialUnknowns.length}</span></summary>
        <div className="judgment-boundary-content">
          {materialUnknowns.length
            ? <ul>{materialUnknowns.map((item) => <li key={item}>{item}</li>)}</ul>
            : <p className="empty-copy">No material evidence gap was identified.</p>}
        </div>
      </details>

      <details className="evidence-vault">
        <summary>
          <span><b>Explore the full analysis</b><small>Alternatives, additional actions, and cited evidence</small></span>
          <span>{alternativeHypotheses.length + secondaryActions.length} items</span>
        </summary>
        <div className="evidence-vault-grid">
          <article>
            <h3>Alternative explanations</h3>
            {alternativeHypotheses.length ? alternativeHypotheses.map((item, index) => (
              <div className="report-item" key={`${item.statement}-${index}`}>
                <span className="confidence">{item.confidence}</span><p>{item.statement}</p><EvidenceLinks ids={item.evidenceIds} />
              </div>
            )) : <p className="empty-copy">No competing evidence-supported explanation was returned.</p>}
          </article>
          <article>
            <h3>Additional safe checks</h3>
            {secondaryActions.length ? secondaryActions.map((item, index) => (
              <div className="report-item" key={`${item.action}-${index}`}>
                <p><strong>{item.action}</strong></p><p className="reason">{item.reason}</p><EvidenceLinks ids={item.evidenceIds} />
              </div>
            )) : <p className="empty-copy">The primary action is the only recommended check.</p>}
          </article>
        </div>
      </details>
      <p className="safety-note">Read-only analysis · No capture, refund, charge, or merchant-state tool is available to the model.</p>
    </section>
  );
}

export function App() {
  const [amount, setAmount] = useState("10.00");
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);
  const [investigation, setInvestigation] = useState<Investigation | null>(null);
  const [status, setStatus] = useState("Loading PayPal Sandbox…");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [checkoutAttempt, setCheckoutAttempt] = useState(0);
  const [checkoutUnavailable, setCheckoutUnavailable] = useState(false);
  const [checkoutInitializing, setCheckoutInitializing] = useState(true);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const amountRef = useRef(amount);
  const orderRef = useRef<Order | null>(null);
  const checkoutValidationRef = useRef<string | null>(null);
  const restoreAttemptedRef = useRef(false);
  const revealInvestigationRef = useRef(false);
  amountRef.current = amount;
  orderRef.current = order;

  const incident = scenario?.incident ?? (reconciliation?.status === "INCIDENT_OPEN" ? reconciliation.incident : null);
  const stage = workflowStage(order, Boolean(scenario), Boolean(incident));
  const graceSeconds = config ? Math.round(config.reconciliationGraceMs / 1_000) : 60;
  const eligibleAt = reconciliation?.status === "GRACE_PERIOD" ? reconciliation.eligibleAt : null;
  const remainingGraceSeconds = graceSecondsRemaining(eligibleAt, clockMs);
  const amountError = amountValidationMessage(amount);
  const aligned = order?.paypalCaptureStatus === "COMPLETED" && order.localStatus === "PAID";
  const progress = useMemo(() => [
    { number: 1, label: "Capture", done: Boolean(order?.paypalCaptureId) },
    { number: 2, label: "Simulate", done: Boolean(scenario) },
    { number: 3, label: "Detect", done: Boolean(incident) },
    { number: 4, label: "Investigate", done: Boolean(investigation) }
  ], [order, scenario, incident, investigation]);
  const actionHint = demoActionHint({
    demoMode: config?.demoMode ?? false,
    busy: busy !== null,
    scenarioStatus: scenario?.status ?? null,
    hasIncident: Boolean(incident),
    hasInvestigation: Boolean(investigation),
    graceRemainingSeconds: remainingGraceSeconds
  });
  const reconciliationDisabled = !scenario
    || scenario.status !== "ACTIVE"
    || busy !== null
    || (reconciliation?.status === "GRACE_PERIOD" && remainingGraceSeconds > 0);

  const setFailure = (cause: unknown) => {
    const message = cause instanceof ApiError
      ? friendlyError(cause.code)
      : cause instanceof Error ? cause.message : "An unexpected error occurred.";
    setError(message);
  };

  const refreshOrderEvidence = async (merchantOrderId: string) => {
    const [freshOrder, freshTimeline] = await Promise.all([
      api<Order>(`/api/orders/${encodeURIComponent(merchantOrderId)}`),
      api<Timeline>(`/api/orders/${encodeURIComponent(merchantOrderId)}/timeline`)
    ]);
    orderRef.current = freshOrder;
    setOrder(freshOrder);
    setTimeline(freshTimeline);
  };

  useEffect(() => {
    if (!eligibleAt) return;
    const eligibleAtMs = new Date(eligibleAt).getTime();
    const initialNow = Date.now();
    setClockMs(initialNow);
    if (!Number.isFinite(eligibleAtMs) || initialNow >= eligibleAtMs) return;
    const timer = window.setInterval(() => {
      const currentNow = Date.now();
      setClockMs(currentNow);
      if (currentNow >= eligibleAtMs) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [eligibleAt]);

  const viewInvestigation = () => {
    const element = document.getElementById("investigation-report");
    if (!element) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    element.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    element.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!investigation || !revealInvestigationRef.current) return;
    revealInvestigationRef.current = false;
    window.requestAnimationFrame(viewInvestigation);
  }, [investigation]);

  useEffect(() => {
    let cancelled = false;
    let buttons: { render(selector: string): Promise<void>; close(): Promise<void> } | undefined;
    setCheckoutInitializing(true);
    setCheckoutUnavailable(false);
    setError(null);
    api<PublicConfig>("/api/config/paypal")
      .then(async (publicConfig) => {
        if (cancelled) return;
        setConfig(publicConfig);
        let restored = false;
        if (!restoreAttemptedRef.current) {
          restoreAttemptedRef.current = true;
          const merchantOrderId = readCurrentOrderId(window.localStorage);
          if (merchantOrderId) {
            try {
              const [restoredOrder, restoredTimeline] = await Promise.all([
                api<Order>(`/api/orders/${encodeURIComponent(merchantOrderId)}`),
                api<Timeline>(`/api/orders/${encodeURIComponent(merchantOrderId)}/timeline`)
              ]);
              if (cancelled) return;
              orderRef.current = restoredOrder;
              setOrder(restoredOrder);
              setTimeline(restoredTimeline);
              if (restoredOrder.scenarioRunId && publicConfig.demoMode) {
                const restoredScenario = await api<Scenario>(`/api/demo/scenario-runs/${encodeURIComponent(restoredOrder.scenarioRunId)}`);
                if (cancelled) return;
                setScenario(restoredScenario);
                if (restoredScenario.incident) {
                  const restoredInvestigation = await api<Investigation | null>(`/api/investigations/scenarios/${encodeURIComponent(restoredScenario.scenarioRunId)}`);
                  if (cancelled) return;
                  setInvestigation(restoredInvestigation);
                }
              }
              restored = true;
            } catch (cause) {
              if (cause instanceof ApiError && cause.status === 404) clearCurrentOrderId(window.localStorage);
              else setFailure(cause);
            }
          }
        }
        await loadPayPalSdk(publicConfig.clientId, publicConfig.currency);
        if (cancelled || !window.paypal) return;
        document.getElementById("paypal-buttons")?.replaceChildren();
        buttons = window.paypal.Buttons({
          createOrder: async () => {
            const validationMessage = amountValidationMessage(amountRef.current);
            if (validationMessage) {
              checkoutValidationRef.current = validationMessage;
              setError(validationMessage);
              throw new Error(validationMessage);
            }
            checkoutValidationRef.current = null;
            setError(null);
            setStatus("Creating a real PayPal Sandbox order…");
            setScenario(null); setReconciliation(null); setInvestigation(null); setTimeline(null);
            const created = await api<Order>("/api/orders", {
              method: "POST",
              body: JSON.stringify({ currencyCode: "USD", value: amountRef.current })
            });
            orderRef.current = created;
            setOrder(created);
            storeCurrentOrderId(window.localStorage, created.merchantOrderId);
            setStatus("Waiting for Sandbox buyer approval…");
            return created.paypalOrderId;
          },
          onApprove: async (data) => {
            setStatus("Capturing on the server…");
            const current = orderRef.current;
            if (!current || current.paypalOrderId !== data.orderID) throw new Error("Approved PayPal order did not match the local merchant order.");
            const captured = await api<Order>(`/api/orders/${encodeURIComponent(current.merchantOrderId)}/capture`, { method: "POST", body: "{}" });
            orderRef.current = captured;
            setOrder(captured);
            setTimeline(await api<Timeline>(`/api/orders/${encodeURIComponent(captured.merchantOrderId)}/timeline`));
            setStatus(captured.paypalCaptureStatus === "COMPLETED" ? "Real Sandbox capture confirmed. The normal path is aligned." : "Capture response recorded.");
          },
          onCancel: () => setStatus("Buyer cancelled the Sandbox checkout."),
          onError: (cause) => {
            const validationMessage = checkoutValidationRef.current;
            if (!validationMessage) console.error(cause);
            setError(validationMessage ?? "PayPal Sandbox checkout failed. Check the API log and Sandbox account configuration.");
          }
        });
        await buttons.render("#paypal-buttons");
        if (!cancelled) {
          setCheckoutUnavailable(false);
          setCheckoutInitializing(false);
          setStatus(restored
            ? "Restored the current merchant order and retained evidence. Sandbox checkout is also ready."
            : "Ready for a real Sandbox checkout.");
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setCheckoutUnavailable(true);
          setCheckoutInitializing(false);
          setFailure(cause);
        }
      });
    return () => { cancelled = true; void buttons?.close(); };
  }, [checkoutAttempt]);

  const runAction = async (name: string, action: () => Promise<void>) => {
    setBusy(name); setError(null);
    try { await action(); } catch (cause) { setFailure(cause); } finally { setBusy(null); }
  };

  const updateAmount = (value: string) => {
    setAmount(value);
    if (!amountValidationMessage(value) && checkoutValidationRef.current) {
      checkoutValidationRef.current = null;
      setError(null);
    }
  };

  const injectFault = () => order && runAction("inject", async () => {
    const created = await api<Scenario>("/api/demo/scenario-runs", { method: "POST", body: JSON.stringify({ merchantOrderId: order.merchantOrderId }) });
    setScenario(created); setReconciliation(null); setInvestigation(null);
    await refreshOrderEvidence(order.merchantOrderId);
    setStatus("Simulated merchant update failure is active. PayPal evidence was not changed.");
  });

  const reconcile = () => scenario && runAction("reconcile", async () => {
    const result = await api<Reconciliation>(`/api/demo/scenario-runs/${encodeURIComponent(scenario.scenarioRunId)}/reconcile`, { method: "POST", body: "{}" });
    setReconciliation(result);
    if (result.status === "INCIDENT_OPEN") {
      setScenario({ ...scenario, incident: result.incident });
      setStatus("Deterministic mismatch incident opened. AI has not decided payment truth.");
    } else if (result.status === "GRACE_PERIOD") {
      setStatus(`Grace period is active. Reconcile again after ${formatTime(result.eligibleAt)}.`);
    } else setStatus("No mismatch currently satisfies the deterministic rule.");
  });

  const generateInvestigation = () => scenario && runAction("investigate", async () => {
    const report = await api<Investigation>(`/api/investigations/scenarios/${encodeURIComponent(scenario.scenarioRunId)}`, { method: "POST", body: "{}" });
    revealInvestigationRef.current = true;
    setInvestigation(report);
    setStatus(report.status === "AI_GENERATED" ? "Evidence-grounded AI report generated and persisted." : "AI was unavailable or invalid; a grounded rule-based report was persisted.");
  });

  const replayScenario = () => scenario && order && runAction("replay", async () => {
    const replay = await api<Scenario>(`/api/demo/scenario-runs/${encodeURIComponent(scenario.scenarioRunId)}/replay`, { method: "POST", body: "{}" });
    setScenario(replay); setReconciliation(null); setInvestigation(null);
    await refreshOrderEvidence(order.merchantOrderId);
    setStatus("Local merchant fault replayed with a new scenario ID. No new PayPal call was made.");
  });

  const resetScenario = () => order && runAction("reset", async () => {
    const resetOrder = await api<Order>(`/api/demo/orders/${encodeURIComponent(order.merchantOrderId)}/reset`, { method: "POST", body: "{}" });
    orderRef.current = resetOrder; setOrder(resetOrder);
    if (scenario) setScenario({ ...scenario, status: "RESET", incident: scenario.incident ? { ...scenario.incident, status: "RESOLVED" } : null });
    setReconciliation(null);
    setTimeline(await api<Timeline>(`/api/orders/${encodeURIComponent(order.merchantOrderId)}/timeline`));
    setStatus("Merchant-only scenario reset. The original PayPal capture evidence remains unchanged.");
  });

  return (
    <main aria-busy={busy !== null}>
      <header className="hero">
        <nav className="brand-row" aria-label="Product context">
          <a className="brand" href="#top" aria-label="PayTrace home"><span>PT</span> PayTrace</a>
          <div className="environment"><i /> Sandbox lab</div>
        </nav>
        <div id="top" className="hero-copy">
          <p className="eyebrow">Payment incident diagnosis</p>
          <h1>Find the break.<br /><em>Act on the evidence.</em></h1>
          <p className="lede">Trace a Sandbox payment from capture to merchant state. Turn the mismatch into a clear diagnosis.</p>
        </div>
        <ol className="progress" aria-label={`Workflow stage ${stage} of 4`}>
          {progress.map((item) => <li className={item.done ? "done" : stage === item.number ? "current" : ""} key={item.number}><span>{item.done ? "✓" : item.number}</span><b>{item.label}</b></li>)}
        </ol>
      </header>

      <section className="checkout-section" aria-labelledby="capture-heading" aria-busy={checkoutInitializing}>
        <div className="section-heading">
          <div><p className="section-kicker">01 · Capture</p><h2 id="capture-heading">Start with a real Sandbox payment</h2></div>
          <span className="source-badge provider">Sandbox PayPal API</span>
        </div>
        <div className="checkout-grid">
          <div>
            <p className="section-copy">The server creates and captures the order. Only allowlisted evidence is retained.</p>
            <label className="amount-field">Amount<span><b>USD</b><input aria-label="Sandbox amount in USD" aria-invalid={amountError !== null} aria-describedby="amount-help" inputMode="decimal" autoComplete="off" value={amount} onChange={(event) => updateAmount(event.target.value)} pattern="\d+\.\d{2}" /></span></label>
            <p id="amount-help" className={amountError ? "field-help field-error" : "field-help"}>{amountError ?? "Use a positive amount with exactly two decimal places."}</p>
          </div>
          <div className="paypal-panel"><div id="paypal-buttons" /><p className="microcopy">Use a Sandbox buyer account.</p></div>
        </div>
        <div className="live-status" role={error ? "alert" : "status"} aria-live={error ? "assertive" : "polite"} aria-atomic="true">
          <span className={error ? "status-dot error-dot" : "status-dot"} />
          <span>{error ?? status}</span>
          {checkoutUnavailable && <button type="button" className="retry-action" onClick={() => setCheckoutAttempt((attempt) => attempt + 1)}>Retry PayPal setup</button>}
        </div>
      </section>

      {order ? (
        <section className="truth-section" aria-labelledby="truth-heading">
          <div className="section-heading">
            <div><p className="section-kicker">Payment truth boundary</p><h2 id="truth-heading">Two systems. Two explicit states.</h2></div>
            {aligned && scenario?.status !== "ACTIVE" && <span className="alignment">Aligned normal path</span>}
          </div>
          <div className="state-grid">
            <StateCard eyebrow="External provider" value={order.paypalCaptureStatus ?? "NOT CAPTURED"} detail="Confirmed by retained PayPal evidence" tone="provider-state" />
            <div className="state-connector" aria-hidden="true">{aligned ? "≈" : "≠"}</div>
            <StateCard eyebrow="Merchant database" value={order.localStatus} detail={order.merchantUpdateFailureInjected ? "Changed by an explicit demo fault" : "Recorded by merchant workflow"} tone={order.localStatus === "PAID" ? "merchant-state" : "warning-state"} />
          </div>
          <dl className="identity-grid">
            <div><dt>Merchant order</dt><dd>{order.merchantOrderId}</dd></div><div><dt>PayPal order</dt><dd>{order.paypalOrderId}</dd></div>
            <div><dt>Capture ID</dt><dd>{order.paypalCaptureId ?? "Awaiting approval"}</dd></div><div><dt>Amount</dt><dd>{order.amount.value} {order.amount.currencyCode}</dd></div>
          </dl>
        </section>
      ) : (
        <section className="empty-state" aria-label="Payment evidence empty state"><span>01</span><div><h2>No payment evidence yet</h2><p>Complete the Sandbox checkout above to unlock the investigation workflow.</p></div></section>
      )}

      {order?.paypalCaptureStatus === "COMPLETED" && (
        <section className="scenario-section" aria-labelledby="scenario-heading" aria-busy={busy !== null}>
          <div className="section-heading">
            <div><p className="section-kicker">02 · Simulate &nbsp;→&nbsp; 03 · Detect</p><h2 id="scenario-heading">Reproduce the merchant-side failure</h2></div>
            <span className="source-badge simulated">Simulated merchant fault</span>
          </div>
          {!config?.demoMode && <div className="callout warning"><strong>Demo controls are disabled.</strong><span>Set <code>DEMO_MODE=true</code> on the API server and restart it. Payment features remain available.</span></div>}
          <p className="section-copy">Changes only the merchant record. No new PayPal order or Capture.</p>
          <div className="action-bar">
            <button className="primary-action" type="button" aria-describedby="action-guidance" title={scenario?.status === "ACTIVE" ? "Reset the active scenario before starting another." : undefined} disabled={!config?.demoMode || busy !== null || scenario?.status === "ACTIVE"} onClick={injectFault}>{busy === "inject" ? "Starting scenario…" : "Simulate merchant update failure"}</button>
            <button type="button" aria-describedby="action-guidance" title={remainingGraceSeconds > 0 ? `Available in ${remainingGraceSeconds}s` : undefined} disabled={reconciliationDisabled} onClick={reconcile}>{busy === "reconcile" ? "Checking…" : remainingGraceSeconds > 0 ? `Reconcile in ${remainingGraceSeconds}s` : "Run deterministic reconciliation"}</button>
            <button type="button" aria-describedby="action-guidance" title={!scenario ? "Start a scenario first." : undefined} disabled={!scenario || scenario.status !== "ACTIVE" || busy !== null} onClick={replayScenario}>{busy === "replay" ? "Replaying…" : "Replay locally"}</button>
            <button className="quiet-action" type="button" aria-describedby="action-guidance" title={!scenario ? "Start a scenario first." : undefined} disabled={!scenario || scenario.status !== "ACTIVE" || busy !== null} onClick={resetScenario}>{busy === "reset" ? "Resetting…" : "Reset merchant state"}</button>
          </div>
          <p id="action-guidance" className="action-guidance"><strong>Next step:</strong> {actionHint}</p>
          <p className="grace-copy">Configured application grace period: <strong>{graceSeconds} seconds</strong>. This is not a PayPal SLA.</p>
          {scenario && <div className="scenario-record"><div><span>Scenario run</span><code>{scenario.scenarioRunId}</code></div><div><span>Status</span><strong>{scenario.status}</strong></div><div><span>Replay of</span><code>{scenario.replayOfScenarioRunId ?? "Original run"}</code></div></div>}
          {reconciliation?.status === "GRACE_PERIOD" && <>
            <div className="callout neutral">
              <strong aria-hidden="true">{remainingGraceSeconds > 0 ? `Ready to detect in ${remainingGraceSeconds}s` : "Ready to detect"}</strong>
              <span aria-hidden="true">{remainingGraceSeconds > 0 ? `Eligible at ${formatTime(reconciliation.eligibleAt)}.` : "The grace period has elapsed. Run reconciliation now."}</span>
              <span className="sr-only">Grace period {remainingGraceSeconds > 0 ? "active. Reconciliation will become available when it elapses." : "elapsed. Run reconciliation now."}</span>
            </div>
            {remainingGraceSeconds === 0 && <span className="sr-only" role="status">The grace period has elapsed. Deterministic reconciliation is ready.</span>}
          </>}
          {incident && (
            <article className={`incident-card ${incident.status.toLowerCase()}`}>
              <div className="incident-icon" aria-hidden="true">!</div>
              <div><p>Deterministic incident · {incident.status}</p><h3>Capture completed, merchant order pending</h3><span>{incident.reconciliationVersion} · detected {formatTime(incident.detectedAt)}</span><EvidenceLinks ids={[incident.captureEvidenceId, incident.merchantStatusEvidenceId]} /></div>
              <div className="incident-actions">
                {investigation ? <>
                  <button className="primary-action" type="button" disabled={busy !== null} onClick={viewInvestigation}>View diagnosis</button>
                  <button className="secondary-action" type="button" aria-describedby="action-guidance" disabled={incident.status !== "OPEN" || busy !== null} onClick={generateInvestigation}>{busy === "investigate" ? "Regenerating…" : "Regenerate"}</button>
                </> : <button className="primary-action" type="button" aria-describedby="action-guidance" disabled={incident.status !== "OPEN" || busy !== null} onClick={generateInvestigation}>{busy === "investigate" ? "Investigating…" : "Generate investigation"}</button>}
              </div>
            </article>
          )}
        </section>
      )}

      {investigation && <InvestigationPanel investigation={investigation} />}
      {timeline && (
        <section className="timeline-section" aria-labelledby="timeline-heading">
          <div className="section-heading"><div><p className="section-kicker">Evidence timeline</p><h2 id="timeline-heading">Every claim keeps its source</h2></div><span className="event-count">{timeline.events.length} events</span></div>
          {timeline.events.length ? <ol className="timeline-list">{timeline.events.map((event, index) => <TimelineEvent event={event} index={index} key={event.evidenceId} />)}</ol> : <p className="empty-copy">No evidence has been recorded for this order.</p>}
        </section>
      )}
      <footer><div><strong>PayTrace</strong><span>Developer investigation lab</span></div><p>Sandbox only · No refunds · No automatic financial remediation · Buyer data excluded</p></footer>
    </main>
  );
}

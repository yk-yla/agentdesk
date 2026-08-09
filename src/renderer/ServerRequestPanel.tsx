import { Check, ExternalLink, KeyRound, ShieldAlert, X } from "lucide-react";
import { memo, useMemo, useState } from "react";
import type { AgentBridge, JsonObject } from "../shared/protocol";
import type { PendingApproval, UserInputQuestion } from "./domain";

interface ServerRequestPanelProps {
  request: PendingApproval;
  bridge: AgentBridge;
  onRespond: (result: JsonObject) => void;
}

function permissionKeys(value: JsonObject) {
  return Object.keys(value).filter((key) => value[key] !== null && typeof value[key] !== "undefined");
}

function permissionSummary(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "请求权限";
  }
}

function schemaFields(schema: JsonObject | undefined) {
  const properties = schema ? schema.properties : undefined;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return Object.entries(properties as JsonObject).map(([name, value]) => {
    const field = value && typeof value === "object" ? value as JsonObject : {};
    const enumValues = Array.isArray(field.enum) ? field.enum.filter((entry): entry is string | number => typeof entry === "string" || typeof entry === "number") : [];
    return { name, type: typeof field.type === "string" ? field.type : "string", title: typeof field.title === "string" ? field.title : name, description: typeof field.description === "string" ? field.description : "", enumValues };
  });
}

function QuestionEditor({ question, value, onChange }: { question: UserInputQuestion; value: string[]; onChange: (next: string[]) => void }) {
  const [other, setOther] = useState(value.find((entry) => entry.startsWith("__other__:"))?.slice(10) || "");
  const options = question.options || [];
  const choose = (label: string, checked: boolean) => {
    if (question.multiSelect) {
      onChange(checked ? [...value.filter((entry) => !entry.startsWith("__other__:")), label] : value.filter((entry) => entry !== label));
    } else {
      onChange([label]);
    }
  };
  return <div className="request-question">
    <label className="request-question-title">{question.header ? <strong>{question.header}</strong> : null}<span>{question.question}</span></label>
    {options.length ? <div className="request-options">
      {options.map((option) => <label className="request-option" key={option.label}>
        <input type={question.multiSelect ? "checkbox" : "radio"} name={`question-${question.id}`} checked={value.includes(option.label)} onChange={(event) => choose(option.label, event.target.checked)} />
        <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
      </label>)}
      {question.isOther ? <label className="request-other"><input type={question.multiSelect ? "checkbox" : "radio"} name={`question-${question.id}`} checked={value.some((entry) => entry.startsWith("__other__:"))} onChange={(event) => { if (!event.target.checked) onChange(value.filter((entry) => !entry.startsWith("__other__:"))); else onChange([`__other__:${other}`]); }} /><span>其他</span><input value={other} onChange={(event) => { setOther(event.target.value); if (value.some((entry) => entry.startsWith("__other__:"))) onChange([`__other__:${event.target.value}`]); }} placeholder="请输入" /></label> : null}
    </div> : question.isSecret ? <input className="request-textarea" type="password" value={value[0] || ""} onChange={(event) => onChange([event.target.value])} placeholder="请输入回答" /> : <textarea className="request-textarea" value={value[0] || ""} onChange={(event) => onChange([event.target.value])} placeholder="请输入回答" rows={2} />}
  </div>;
}

function ServerRequestPanel(props: ServerRequestPanelProps) {
  const { request } = props;
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [permissions, setPermissions] = useState(() => new Set(permissionKeys(request.permissions || {})));
  const [schemaValues, setSchemaValues] = useState<JsonObject>({});
  const fields = useMemo(() => schemaFields(request.requestedSchema), [request.requestedSchema]);
  const decisions = request.availableDecisions?.length ? request.availableDecisions : request.kind === "fileApproval" ? ["accept", "acceptForSession", "decline", "cancel"] : ["accept", "acceptForSession", "decline", "cancel"];
  const decisionPayloads = request.availableDecisionPayloads || [];

  const respondDecision = (decision: string) => {
    const payload = decisionPayloads.find((entry) => typeof entry === "object" && entry !== null && decision in (entry as JsonObject));
    if (payload && typeof payload === "object") {
      props.onRespond({ decision: payload });
      return;
    }
    if (decision === "acceptWithExecpolicyAmendment") {
      const amendment = request.proposedExecpolicyAmendment;
      const commands = Array.isArray(amendment) ? amendment.filter((entry): entry is string => typeof entry === "string") : [];
      props.onRespond({ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: commands } } });
      return;
    }
    props.onRespond({ decision });
  };

  if (request.kind === "userInput") {
    return <section className="server-request-panel" role="dialog" aria-label={request.title}>
      <div className="server-request-heading"><KeyRound size={16} /><div><strong>{request.title}</strong><span>{request.detail}</span></div></div>
      <div className="request-form">{(request.questions || []).map((question) => <QuestionEditor key={question.id} question={question} value={answers[question.id] || []} onChange={(next) => setAnswers((current) => ({ ...current, [question.id]: next }))} />)}</div>
      <div className="request-actions"><button className="request-button secondary" onClick={() => props.onRespond({ answers: {} })}><X size={13} />取消</button><button className="request-button primary" onClick={() => props.onRespond({ answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: values.map((value) => value.startsWith("__other__:") ? value.slice(10) : value) }])) })}><Check size={13} />提交回答</button></div>
    </section>;
  }

  if (request.kind === "elicitation") {
    if (request.elicitationMode === "url") return <section className="server-request-panel" role="dialog" aria-label={request.title}>
      <div className="server-request-heading"><ExternalLink size={16} /><div><strong>{request.title}</strong><span>{request.elicitationMessage || request.detail}</span></div></div>
      {request.elicitationUrl ? <code className="request-url">{request.elicitationUrl}</code> : null}
      <div className="request-actions"><button className="request-button secondary" onClick={() => props.onRespond({ action: "cancel", content: null, _meta: null })}><X size={13} />取消</button><button className="request-button secondary" onClick={() => props.onRespond({ action: "decline", content: null, _meta: null })}>拒绝</button>{request.elicitationUrl ? <button className="request-button secondary" onClick={() => void props.bridge.openExternal(request.elicitationUrl!)}><ExternalLink size={13} />打开链接</button> : null}<button className="request-button primary" onClick={() => props.onRespond({ action: "accept", content: {}, _meta: null })}><Check size={13} />已完成</button></div>
    </section>;
    return <section className="server-request-panel" role="dialog" aria-label={request.title}>
      <div className="server-request-heading"><KeyRound size={16} /><div><strong>{request.title}</strong><span>{request.elicitationMessage || request.detail}</span></div></div>
      <div className="request-form">{fields.length ? fields.map((field) => <label className="request-field" key={field.name}><span>{field.title}</span>{field.enumValues.length ? <select value={String(schemaValues[field.name] ?? "")} onChange={(event) => setSchemaValues((current) => ({ ...current, [field.name]: event.target.value }))}><option value="">请选择</option>{field.enumValues.map((entry) => <option value={String(entry)} key={String(entry)}>{String(entry)}</option>)}</select> : field.type === "boolean" ? <input type="checkbox" checked={schemaValues[field.name] === true} onChange={(event) => setSchemaValues((current) => ({ ...current, [field.name]: event.target.checked }))} /> : <input value={String(schemaValues[field.name] ?? "")} onChange={(event) => setSchemaValues((current) => ({ ...current, [field.name]: event.target.value }))} placeholder={field.description} />}</label>) : <p className="request-hint">此 MCP 表单没有可编辑字段。</p>}</div>
      <div className="request-actions"><button className="request-button secondary" onClick={() => props.onRespond({ action: "cancel", content: null, _meta: null })}><X size={13} />取消</button><button className="request-button secondary" onClick={() => props.onRespond({ action: "decline", content: null, _meta: null })}>拒绝</button><button className="request-button primary" onClick={() => props.onRespond({ action: "accept", content: schemaValues, _meta: null })}><Check size={13} />提交</button></div>
    </section>;
  }

  if (request.kind === "permissionsApproval") {
    const requested = request.permissions || {};
    return <section className="server-request-panel" role="dialog" aria-label={request.title}>
      <div className="server-request-heading"><ShieldAlert size={16} /><div><strong>{request.title}</strong><span>{request.detail}</span></div></div>
      <div className="permission-list">{permissionKeys(requested).length ? permissionKeys(requested).map((key) => <label className="permission-row" key={key}><input type="checkbox" checked={permissions.has(key)} onChange={(event) => setPermissions((current) => { const next = new Set(current); if (event.target.checked) next.add(key); else next.delete(key); return next; })} /><code>{key}</code><span>{permissionSummary(requested[key])}</span></label>) : <p className="request-hint">未提供可授予的权限明细。</p>}</div>
      <div className="request-actions"><button className="request-button secondary" onClick={() => props.onRespond({ permissions: {}, scope: "turn" })}><X size={13} />拒绝</button><button className="request-button primary" onClick={() => props.onRespond({ permissions: Object.fromEntries(permissionKeys(requested).filter((key) => permissions.has(key)).map((key) => [key, requested[key]])), scope: "session" })}><Check size={13} />允许所选</button></div>
    </section>;
  }

  return <section className="server-request-panel approval-request-panel" role="dialog" aria-label={request.title}>
    <div className="server-request-heading"><ShieldAlert size={16} /><div><strong>{request.title}</strong><span>{request.detail}</span>{request.cwd ? <code>{request.cwd}</code> : null}{request.grantRoot ? <code>授权目录：{request.grantRoot}</code> : null}</div></div>
    {request.reason && request.reason !== request.detail ? <p className="request-reason">{request.reason}</p> : null}
    {request.networkApprovalContext ? <p className="request-hint">这是针对指定网络地址的授权，不会改变其他命令的权限。</p> : null}
    {request.proposedExecpolicyAmendment ? <pre className="request-amendment">{JSON.stringify(request.proposedExecpolicyAmendment, null, 2)}</pre> : null}
    <div className="request-actions">{decisions.includes("cancel") ? <button className="request-button secondary" onClick={() => respondDecision("cancel")}><X size={13} />取消</button> : null}{decisions.includes("decline") ? <button className="request-button secondary" onClick={() => respondDecision("decline")}>拒绝</button> : null}{decisions.includes("acceptForSession") ? <button className="request-button secondary" onClick={() => respondDecision("acceptForSession")}>本会话允许</button> : null}{decisions.includes("acceptWithExecpolicyAmendment") ? <button className="request-button secondary" onClick={() => respondDecision("acceptWithExecpolicyAmendment")}>允许并记住规则</button> : null}{decisions.includes("applyNetworkPolicyAmendment") ? <button className="request-button secondary" onClick={() => respondDecision("applyNetworkPolicyAmendment")}>允许网络策略</button> : null}{decisions.includes("accept") ? <button className="request-button primary" onClick={() => respondDecision("accept")}><Check size={13} />允许</button> : null}</div>
  </section>;
}

export default memo(ServerRequestPanel);

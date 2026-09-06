import { escapeHtml, formatDate } from "../core.js";
import { normalizeMessageId } from "./message-identity.js";

export function messageCenterMarkup() {
  return `<section class="section-heading"><div><p class="eyebrow">Shared with both games</p><h1>Message Center</h1><p>Send a message using a player's Message ID and nickname.</p></div></section>
  <div class="form-row"><section class="panel"><div class="message-identity">
    <h2>Your message details</h2>
    <div class="field"><label for="own-message-id">Your Message ID</label><input class="input message-id-display" id="own-message-id" readonly placeholder="Loading…" aria-describedby="message-id-help" /></div>
    <p>Nickname: <strong id="own-message-nickname">Loading…</strong></p>
    <button class="btn btn-secondary" id="copy-message-details" type="button" disabled>Copy ID & nickname</button>
    <p class="field-help" id="message-id-help">Share both details so friends can message you. Your ID stays the same in both games.</p>
    <p class="field-help" id="message-identity-status" role="status"></p>
  </div><h2>New message</h2><form id="message-form" class="form-grid">
    <div class="field"><label for="message-recipient-id">Player’s Message ID</label><input class="input message-id-entry" id="message-recipient-id" type="text" minlength="16" maxlength="24" placeholder="16 letters and numbers" required autocomplete="off" autocapitalize="characters" spellcheck="false" /></div>
    <div class="field"><label for="message-nickname">Player’s nickname</label><input class="input" id="message-nickname" maxlength="30" required autocomplete="off" /></div>
    <p id="reply-status" class="field-help hidden"></p>
    <div class="field"><label for="message-body">Your message</label><textarea class="input" id="message-body" rows="5" maxlength="2000" required></textarea></div>
    <button class="btn btn-main" type="submit">SEND MESSAGE</button><button class="btn btn-ghost hidden" id="cancel-reply" type="button">Cancel reply</button>
    <p class="field-help">Messages appear here in either game. Keep messages suitable for the game group.</p>
  </form></section><section class="panel"><div class="panel-header"><h2>Your Messages</h2><p>Latest 100 sent and received messages.</p></div><div id="message-list" aria-live="polite">Loading messages…</div></section></div>`;
}

export function bindMessageCenter(service, action, notify) {
  const form = document.querySelector("#message-form");
  const recipientId = document.querySelector("#message-recipient-id");
  const nickname = document.querySelector("#message-nickname");
  const body = document.querySelector("#message-body");
  const list = document.querySelector("#message-list");
  const status = document.querySelector("#reply-status");
  const cancel = document.querySelector("#cancel-reply");
  const ownId = document.querySelector("#own-message-id");
  const ownNickname = document.querySelector("#own-message-nickname");
  const identityStatus = document.querySelector("#message-identity-status");
  const copy = document.querySelector("#copy-message-details");
  let active = true;
  let reply = null;
  ownId.onfocus = () => ownId.select();
  recipientId.onblur = () => { recipientId.value = normalizeMessageId(recipientId.value); };
  service.ensureMessageIdentity().then((identity) => {
    if (!active || !ownId.isConnected) return;
    ownId.value = identity.messageId;
    ownNickname.textContent = identity.displayName;
    copy.disabled = false;
    copy.onclick = async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(`Message ID: ${identity.messageId}\nNickname: ${identity.displayName}`);
        if (active) identityStatus.textContent = "ID and nickname copied. Share them with a friend.";
      } catch {
        if (!active) return;
        ownId.focus(); ownId.select();
        identityStatus.textContent = `Copy the selected ID and share your nickname: ${identity.displayName}.`;
      }
    };
  }).catch((error) => {
    if (!active || !ownId.isConnected) return;
    ownId.placeholder = "Not available yet";
    ownNickname.textContent = service.profile?.displayName || "Player";
    identityStatus.textContent = error.code === "MESSAGE_SETUP_REQUIRED" ? error.message : "Your Message ID could not load. Use Refresh to try again.";
  });
  const reset = () => {
    reply = null;
    recipientId.disabled = nickname.disabled = false;
    status.classList.add("hidden"); cancel.classList.add("hidden");
  };
  cancel.onclick = reset;
  form.onsubmit = (event) => {
    event.preventDefault();
    const value = body.value.trim();
    if (!value) return;
    action(event.submitter, async () => {
      await service.sendMessage({ messageId: recipientId.value, displayName: nickname.value, body: value, replyTo: reply });
      body.value = "";
      reset();
      notify("Message sent.", "success");
    }, "Sending…");
  };
  const unsubscribe = service.watchMessages((messages) => {
    if (!list.isConnected) return;
    list.innerHTML = messages.length ? messages.map((message) => {
      const incoming = message.toUid === service.identityUid();
      return `<article class="message-item ${incoming && !message.readAt ? "unread" : ""}"><div class="message-heading"><strong>${incoming ? "From" : "To"} ${escapeHtml(incoming ? message.fromName : message.toName)}</strong><small>${escapeHtml(formatDate(message.createdAt))}</small></div><p class="message-body">${escapeHtml(message.body)}</p><div class="button-row">${incoming ? `<button class="btn btn-small btn-secondary" data-reply="${escapeHtml(message.id)}">Reply</button>${!message.readAt ? `<button class="btn btn-small btn-ghost" data-read="${escapeHtml(message.id)}">Mark read</button>` : ""}` : `<span class="pill">Sent</span>`}<button class="btn btn-small btn-ghost" data-delete="${escapeHtml(message.id)}">Delete my copy</button></div></article>`;
    }).join("") : `<div class="empty-state"><strong>No messages yet</strong>Your sent and received messages will appear here.</div>`;
    list.querySelectorAll("[data-reply]").forEach((button) => button.onclick = () => {
      const message = messages.find((item) => item.id === button.dataset.reply);
      reply = { id: message.id, uid: message.fromUid, name: message.fromName };
      recipientId.disabled = nickname.disabled = true;
      status.textContent = `Replying to ${message.fromName}`;
      status.classList.remove("hidden"); cancel.classList.remove("hidden");
      body.focus();
    });
    list.querySelectorAll("[data-read]").forEach((button) => button.onclick = () => action(button, () => service.markMessageRead(button.dataset.read), "Saving…"));
    list.querySelectorAll("[data-delete]").forEach((button) => button.onclick = () => action(button, () => service.deleteMessage(button.dataset.delete), "Deleting…"));
  }, (error) => {
    if (!active) return;
    list.textContent = "Messages could not load. Use Refresh to try again.";
    console.error(error);
  });
  return () => { active = false; unsubscribe(); };
}

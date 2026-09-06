import { escapeHtml, formatDate } from "../core.js";

export function messageCenterMarkup() {
  return `<section class="section-heading"><div><p class="eyebrow">Shared with both games</p><h1>Message Center</h1><p>Send a message to an existing player using their email and nickname.</p></div></section>
  <div class="form-row"><section class="panel"><form id="message-form" class="form-grid">
    <div class="field"><label for="message-email">Player’s email</label><input class="input" id="message-email" type="email" required autocomplete="off" /></div>
    <div class="field"><label for="message-nickname">Player’s nickname</label><input class="input" id="message-nickname" maxlength="30" required autocomplete="off" /></div>
    <p id="reply-status" class="field-help hidden"></p>
    <div class="field"><label for="message-body">Your message</label><textarea class="input" id="message-body" rows="5" maxlength="2000" required></textarea></div>
    <button class="btn btn-main" type="submit">SEND MESSAGE</button><button class="btn btn-ghost hidden" id="cancel-reply" type="button">Cancel reply</button>
    <p class="field-help">Messages appear here in either game; they aren’t emails or phone notifications. This uses the same email-and-nickname player entry as the games, so keep messages suitable for the game group.</p>
  </form></section><section class="panel"><div class="panel-header"><h2>Your Messages</h2><p>Latest 100 sent and received messages.</p></div><div id="message-list" aria-live="polite">Loading messages…</div></section></div>`;
}

export function bindMessageCenter(service, action, notify) {
  const form = document.querySelector("#message-form");
  const email = document.querySelector("#message-email");
  const nickname = document.querySelector("#message-nickname");
  const body = document.querySelector("#message-body");
  const list = document.querySelector("#message-list");
  const status = document.querySelector("#reply-status");
  const cancel = document.querySelector("#cancel-reply");
  let reply = null;
  const reset = () => {
    reply = null;
    email.disabled = nickname.disabled = false;
    status.classList.add("hidden"); cancel.classList.add("hidden");
  };
  cancel.onclick = reset;
  form.onsubmit = (event) => {
    event.preventDefault();
    const value = body.value.trim();
    if (!value) return;
    action(event.submitter, async () => {
      await service.sendMessage({ email: email.value, displayName: nickname.value, body: value, replyTo: reply });
      body.value = "";
      reset();
      notify("Message sent.", "success");
    }, "Sending…");
  };
  return service.watchMessages((messages) => {
    if (!list.isConnected) return;
    list.innerHTML = messages.length ? messages.map((message) => {
      const incoming = message.toUid === service.identityUid();
      return `<article class="message-item ${incoming && !message.readAt ? "unread" : ""}"><div class="message-heading"><strong>${incoming ? "From" : "To"} ${escapeHtml(incoming ? message.fromName : message.toName)}</strong><small>${escapeHtml(formatDate(message.createdAt))}</small></div><p class="message-body">${escapeHtml(message.body)}</p><div class="button-row">${incoming ? `<button class="btn btn-small btn-secondary" data-reply="${escapeHtml(message.id)}">Reply</button>${!message.readAt ? `<button class="btn btn-small btn-ghost" data-read="${escapeHtml(message.id)}">Mark read</button>` : ""}` : `<span class="pill">Sent</span>`}<button class="btn btn-small btn-ghost" data-delete="${escapeHtml(message.id)}">Delete my copy</button></div></article>`;
    }).join("") : `<div class="empty-state"><strong>No messages yet</strong>Your sent and received messages will appear here.</div>`;
    list.querySelectorAll("[data-reply]").forEach((button) => button.onclick = () => {
      const message = messages.find((item) => item.id === button.dataset.reply);
      reply = { id: message.id, uid: message.fromUid, name: message.fromName };
      email.disabled = nickname.disabled = true;
      status.textContent = `Replying to ${message.fromName}`;
      status.classList.remove("hidden"); cancel.classList.remove("hidden");
      body.focus();
    });
    list.querySelectorAll("[data-read]").forEach((button) => button.onclick = () => action(button, () => service.markMessageRead(button.dataset.read), "Saving…"));
    list.querySelectorAll("[data-delete]").forEach((button) => button.onclick = () => action(button, () => service.deleteMessage(button.dataset.delete), "Deleting…"));
  }, (error) => {
    list.textContent = "Messages could not load. Publish the updated Firebase rules, then reopen Message Center.";
    console.error(error);
  });
}

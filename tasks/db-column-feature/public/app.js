const form = document.querySelector("#create-form");
const formError = document.querySelector("#form-error");
const tableBody = document.querySelector("#tickets tbody");

function showError(message) {
  formError.textContent = message;
  formError.hidden = !message;
}

function renderTickets(tickets) {
  tableBody.replaceChildren();
  for (const ticket of tickets) {
    const row = document.createElement("tr");
    // Cells are built with textContent (never innerHTML) so ticket values are
    // rendered as text and can never inject markup.
    appendCell(row, ticket.title);
    appendCell(row, ticket.description);
    appendCell(row, new Date(ticket.createdAt).toLocaleString());
    tableBody.appendChild(row);
  }
}

function appendCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = value;
  row.appendChild(cell);
}

async function loadTickets() {
  const response = await fetch("/api/tickets");
  if (!response.ok) {
    showError("Could not load tickets.");
    return;
  }
  renderTickets(await response.json());
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");

  const payload = {
    title: form.title.value,
    description: form.description.value,
  };

  const response = await fetch("/api/tickets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (response.ok) {
    form.reset();
    await loadTickets();
    return;
  }

  const data = await response.json().catch(() => ({}));
  showError((data.errors ?? ["Could not create ticket."]).join(" "));
});

loadTickets();

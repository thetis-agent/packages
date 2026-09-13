const params = new URLSearchParams(location.search);
const next = params.get("next");
if (next && next.startsWith("/") && !next.startsWith("//")) document.getElementById("next").value = next;
if (params.get("error") === "refused") {
  const banner = document.getElementById("banner");
  banner.textContent = "The id or password was refused.";
  banner.hidden = false;
}

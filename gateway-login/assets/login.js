(function () {
  var params = new URLSearchParams(location.search);
  var next = params.get("next");
  if (next) document.getElementById("next").value = next;
  if (params.get("error") === "refused") {
    var banner = document.getElementById("banner");
    banner.textContent = "The id or password was refused.";
    banner.hidden = false;
  }
})();

const copyButton = document.getElementById("copy-install");
const installCommand = document.getElementById("install-command");
const copyStatus = document.getElementById("copy-status");

copyButton.addEventListener("click", async () => {
  copyStatus.textContent = "";
  try {
    await navigator.clipboard.writeText(installCommand.textContent);
    copyStatus.textContent = "Install command copied.";
  } catch (error) {
    copyStatus.textContent = "Copy failed. Check your browser clipboard permission.";
    throw error;
  }
});

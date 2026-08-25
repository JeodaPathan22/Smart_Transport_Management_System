/**
 * Small formatting helpers made available to every Pug template via
 * app.locals, so schedule times / labels are never hard-coded in views -
 * they always come from the database and are just formatted for display.
 */

function formatTime12h(time) {
  if (!time) return null;
  const parts = String(time).split(':');
  if (parts.length < 2) return time;
  let hours = parseInt(parts[0], 10);
  const minutes = parts[1];
  if (Number.isNaN(hours)) return time;
  const suffix = hours >= 12 ? 'PM' : 'AM';
  hours %= 12;
  if (hours === 0) hours = 12;
  return `${hours}:${minutes} ${suffix}`;
}

function titleCase(value) {
  if (!value) return '';
  return String(value)
    .split(/[\s_-]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatDateHuman(dateStr) {
  if (!dateStr) return null;
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTimeHuman(dateTimeStr) {
  if (!dateTimeStr) return null;
  const date = new Date(`${dateTimeStr.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return dateTimeStr;
  return date.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

module.exports = {
  formatTime12h,
  titleCase,
  formatDateHuman,
  formatDateTimeHuman,
};

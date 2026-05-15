export function includesText(source: string, query: string) {
  return source.toLowerCase().includes(query.trim().toLowerCase());
}

export function matchesSelect(value: string, selected: string) {
  return selected === "all" || value === selected;
}

export function matchesDate(sourceDate: string, selectedDate: string) {
  if (!selectedDate) return true;
  const [day, month, year] = sourceDate.split(".");
  return `${year}-${month}-${day}` === selectedDate;
}

export function inDateRange(sourceDateTime: string, from: string, to: string) {
  const [date] = sourceDateTime.split(" ");
  const [day, month, year] = (date ?? "").split(".");
  const isoDate = `${year}-${month}-${day}`;
  return (!from || isoDate >= from) && (!to || isoDate <= to);
}

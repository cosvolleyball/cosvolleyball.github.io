export const courtPositions = ["outside", "setter", "middle", "libero", "right side"];
export const positionChoices = [...courtPositions, "flex"];

const aliases = new Map([
  ["outside hitter", "outside"], ["oh", "outside"], ["s", "setter"],
  ["middle blocker", "middle"], ["mb", "middle"], ["l", "libero"],
  ["opposite", "right side"], ["opposite hitter", "right side"], ["rs", "right side"]
]);

export function normalizedPosition(value) {
  const name = String(value ?? "").trim().toLowerCase();
  return aliases.get(name) ?? name;
}

export function normalizedGender(value) {
  const name = String(value ?? "").trim().toLowerCase();
  if (name === "m") return "male";
  if (name === "f") return "female";
  return name;
}

export function coveredPositions(player) {
  const roles = (player.positions || []).map(normalizedPosition);
  return roles.includes("flex") ? courtPositions : roles;
}

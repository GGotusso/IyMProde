// Curva de balance de precios del Fantasy.
//
// Problema: casi todos los jugadores estaban al piso (4.5-5.5) y los cracks
// baratos, así que entraban ~6 estrellas en un plantel. Solución sin inventar
// datos: estirar la curva HACIA ARRIBA preservando el orden — el fondo queda
// barato (enablers) y los cracks se vuelven caros de verdad.
//
//   nuevo = 4.5 + (precio - 4.5)^EXP * SCALE   (redondeado a 0.5)
//
// Con EXP=1.4 / SCALE=0.614: techo ~21M y en un XI de ≤100M entran como
// máximo ~3 jugadores ≥15M (4 ≥10M). El piso 4.5 se mantiene.
const FLOOR = 4.5;
const EXP = 1.4;
const SCALE = 0.614;

export function balance(price) {
  const p = Number(price) || FLOOR;
  const v = FLOOR + Math.pow(Math.max(p - FLOOR, 0), EXP) * SCALE;
  return Math.round(v * 2) / 2; // a múltiplos de 0.5
}

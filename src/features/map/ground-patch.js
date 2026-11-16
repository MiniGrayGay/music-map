import natlanImage from './natlan-49-01.webp?url';

// 7.2 Map_Natlan_Grp_49_01 / UI_Map_Natlan_49_01: client-authored RectTransform
// (-2898.91, -449.79), 122×83, relative to the Teyvat atlas anchor (4352, 2560).
// The asset's alpha includes the material's rectangular soft edge (11.098779).
export const groundPatch = {map: 'Teyvat', left: 1392.09, top: 2968.29, width: 122, height: 83};
let pending;

export function loadGroundPatch() {
  pending ??= new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => { pending = null; reject(new Error('奥奇卡纳塔贴片加载失败')); };
    image.src = natlanImage;
  });
  return pending;
}

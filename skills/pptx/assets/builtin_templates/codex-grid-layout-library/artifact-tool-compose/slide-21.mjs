import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide21Tokens = contentTokens["slide-21"];

export function buildSlide21(presentation, tokens = slide21Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-21", width: "fill", height: "fill" }, [
      image({
        name: "Picture-4",
        prompt: "dominant hero visual matching this template's visual system; subject or semantic cue: Picture 4; palette cues: tx1, #000000; image treatment: crop left 46.706%, top 0.209%, right 4.058%, bottom 4.713%; no embedded text, preserve generous crop room for slide overlays",
        alt: "hero placeholder for Picture 4",
        fit: "cover",
        crop: {"left":0.46706,"top":0.00209,"right":0.04058,"bottom":0.04713},
        rotation: 90,
        ...frame({ left: "474px", top: "-86px", width: "331px", height: "1280px" }),
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "992px", height: "385px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      text([tokens.body1.titleHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-15",
        ...frame({ left: "452px", top: "507px", width: "375px", height: "123px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.body2.titleHere, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Text-Placeholder-16",
        ...frame({ left: "864px", top: "507px", width: "375px", height: "123px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "452px", top: "457px", width: "27px", height: "27px" }),
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "863px", top: "457px", width: "27px", height: "27px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

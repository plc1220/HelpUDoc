import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide19Tokens = contentTokens["slide-19"];

export function buildSlide19(presentation, tokens = slide19Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-19", width: "fill", height: "fill" }, [
      text([tokens.body1.speakerFullName, tokens.body1.speakerTitleRole], {
        name: "Google-Shape-534-p58",
        ...frame({ left: "41px", top: "561px", width: "375px", height: "68px" }),
        style: textStyles.helveticaNeueFont32TopColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "616px", height: "281px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      text([tokens.body2.speakerFullName, tokens.body2.speakerTitleRole], {
        name: "Google-Shape-534-p58",
        ...frame({ left: "453px", top: "561px", width: "375px", height: "68px" }),
        style: textStyles.helveticaNeueFont32TopColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-4",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "41px", top: "421px", width: "103px", height: "104px" }),
      }),
      shape({
        name: "Rounded-Rectangle-5",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "453px", top: "421px", width: "103px", height: "104px" }),
      }),
      image({
        name: "Picture-3",
        prompt: "dominant hero visual matching this template's visual system; subject or semantic cue: Picture 3; palette cues: tx1, bg2, lt1; image treatment: crop left 5.958%, top 0%, right 0%, bottom 26.52%; no embedded text, preserve generous crop room for slide overlays",
        alt: "hero placeholder for Picture 3",
        fit: "cover",
        crop: {"left":0.05958,"top":0,"right":0,"bottom":0.2652},
        ...frame({ left: "828px", top: "41px", width: "410px", height: "640px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

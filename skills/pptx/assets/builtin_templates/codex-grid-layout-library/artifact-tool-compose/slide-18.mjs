import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide18Tokens = contentTokens["slide-18"];

export function buildSlide18(presentation, tokens = slide18Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-18", width: "fill", height: "fill" }, [
      text([tokens.body1.speakerFullName, tokens.body1.speakerTitleRole], {
        name: "Google-Shape-534-p58",
        ...frame({ left: "41px", top: "572px", width: "375px", height: "68px" }),
        style: textStyles.helveticaNeueFont32TopColorTx1,
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "616px", height: "281px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      text([tokens.body2.speakerFullName, tokens.body2.speakerTitleRole], {
        name: "Google-Shape-534-p58",
        ...frame({ left: "453px", top: "572px", width: "375px", height: "68px" }),
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
        name: "Picture-2",
        prompt: "dominant hero visual matching this template's visual system; subject or semantic cue: Picture 2; palette cues: tx1, bg2, lt1; image treatment: crop left 0%, top 15.849%, right 4.023%, bottom 15.849%; no embedded text, preserve generous crop room for slide overlays",
        alt: "hero placeholder for Picture 2",
        fit: "cover",
        crop: {"left":0,"top":0.15849,"right":0.04023,"bottom":0.15849},
        ...frame({ left: "774px", top: "3px", width: "506px", height: "720px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

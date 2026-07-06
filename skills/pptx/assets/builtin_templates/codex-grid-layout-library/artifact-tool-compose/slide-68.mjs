import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide68Tokens = contentTokens["slide-68"];

export function buildSlide68(presentation, tokens = slide68Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-68", width: "fill", height: "fill" }, [
      text([tokens.body1.titleHere, tokens.body1.loremIpsumDolorSitAmetQuamConsectetur], {
        name: "Google-Shape-534-p58",
        ...frame({ left: "41px", top: "540px", width: "375px", height: "104px" }),
        style: textStyles.helveticaNeueFont32TopColorTx1,
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.body2.titleHere, tokens.body2.loremIpsumDolorSitAmetQuamConsectetur], {
        name: "Content-Placeholder-1",
        ...frame({ left: "453px", top: "540px", width: "375px", height: "104px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.body3.titleHere, tokens.body3.loremIpsumDolorSitAmetQuamConsectetur], {
        name: "Content-Placeholder-2",
        ...frame({ left: "864px", top: "540px", width: "375px", height: "104px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "1197px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-3",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "41px", top: "146px", width: "375px", height: "380px" }),
      }),
      shape({
        name: "Rounded-Rectangle-4",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "453px", top: "146px", width: "375px", height: "380px" }),
      }),
      shape({
        name: "Rounded-Rectangle-5",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "864px", top: "146px", width: "375px", height: "380px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

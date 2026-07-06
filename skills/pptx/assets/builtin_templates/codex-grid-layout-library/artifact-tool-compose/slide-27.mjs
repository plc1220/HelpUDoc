import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide27Tokens = contentTokens["slide-27"];

export function buildSlide27(presentation, tokens = slide27Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-27", width: "fill", height: "fill" }, [
      text([tokens.body1.titleHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Google-Shape-534-p58",
        ...frame({ left: "41px", top: "208px", width: "581px", height: "416px" }),
        style: textStyles.helveticaNeueFont32TopColorTx1,
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "1197px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-1",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "657px", top: "213px", width: "271px", height: "416px" }),
      }),
      shape({
        name: "Rounded-Rectangle-2",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "966px", top: "213px", width: "273px", height: "416px" }),
      }),
      text([tokens.body2.titleHere, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-17",
        ...frame({ left: "685px", top: "441px", width: "225px", height: "168px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.body3.titleHere, tokens.body3.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Text-Placeholder-18",
        ...frame({ left: "994px", top: "441px", width: "226px", height: "168px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide71Tokens = contentTokens["slide-71"];

export function buildSlide71(presentation, tokens = slide71Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-71", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Slide-Number-Placeholder-3",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15BottomRightColorTx1,
      }),
      text([tokens.title], {
        name: "Title-7",
        ...frame({ left: "41px", top: "36px", width: "1197px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-4",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "41px", top: "249px", width: "375px", height: "380px" }),
      }),
      shape({
        name: "Rounded-Rectangle-5",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "453px", top: "249px", width: "375px", height: "380px" }),
      }),
      shape({
        name: "Rounded-Rectangle-6",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "864px", top: "249px", width: "375px", height: "380px" }),
      }),
      text([tokens.body1.titleHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-8",
        ...frame({ left: "74px", top: "353px", width: "310px", height: "208px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.body2.titleHere, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-9",
        ...frame({ left: "486px", top: "353px", width: "310px", height: "208px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.body3.titleHere, tokens.body3.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-10",
        ...frame({ left: "897px", top: "353px", width: "310px", height: "208px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      shape({
        name: "Google-Shape-303-p29",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "898px", top: "290px", width: "24px", height: "27px" }),
      }),
      shape({
        name: "Google-Shape-304-p29",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "486px", top: "290px", width: "27px", height: "27px" }),
      }),
      shape({
        name: "Google-Shape-305-p29",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "73px", top: "290px", width: "27px", height: "27px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

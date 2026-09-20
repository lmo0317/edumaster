using System.Text.Json.Nodes;
using EduMaster.Core;
namespace EduMaster.Core.Tests;
public class ScientificVisualTests
{
    static JsonNode Panels()=>JsonNode.Parse("""[{"title":"(나)","unit":"d","charges":[{"name":"A","position":0,"sign":"unknown","forceDirection":"none"},{"name":"C","position":2,"sign":"unknown","forceDirection":"none"},{"name":"B","position":3,"sign":"+","forceDirection":"-x"}]}]""")!;
    [Fact]public void KeepsRealThirdDPositionAndOnlyGivenForce(){var diagram=Assert.Single(ScientificVisuals.ParseDiagrams(Panels()));Assert.Equal(3,diagram.Charges[2].Position);Assert.Equal("-x",diagram.Charges[2].ForceDirection);Assert.Equal("unknown",diagram.Charges[0].Sign);Assert.Equal("none",diagram.Charges[0].ForceDirection);}
    [Fact]public void MissingPositionCannotBecomeFourD(){var node=Panels();node[0]!["charges"]![2]!.AsObject().Remove("position");Assert.Throws<InvalidDataException>(()=>ScientificVisuals.ParseDiagrams(node));}
    [Fact]public void DistinctChargesCannotSharePosition(){var node=Panels();node[0]!["charges"]![2]!["position"]=2.0;Assert.Throws<InvalidDataException>(()=>ScientificVisuals.ParseDiagrams(node));}
    [Fact]public void GraphCannotUseDefaultZeroForBadNumber(){var node=JsonNode.Parse("""{"type":"line","xPoints":[0,"broken"],"yPoints":[0,1]}""");Assert.Throws<InvalidOperationException>(()=>ScientificVisuals.ParseGraph(node));}
    [Fact]public void MissingGraphRemainsMissing()=>Assert.Null(ScientificVisuals.ParseGraph(null));
}


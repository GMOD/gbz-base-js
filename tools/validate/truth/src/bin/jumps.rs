// Edges that join two nodes of one reference path far apart along it: a
// window beside one end reaches the other end through the edge. Usage:
//   jumps graph.gbz SAMPLE min_bp > jumps.tsv
// jumps.tsv holds `contig<TAB>fragment<TAB>from<TAB>to` per edge: the end of the
// lower node and the start of the higher one, as offsets along the path.
use gbz::{Orientation, GBZ};
use simple_sds::serialize;

use std::collections::{HashMap, HashSet};
use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        eprintln!("Usage: jumps graph.gbz SAMPLE min_bp > jumps.tsv");
        std::process::exit(1);
    }
    let graph: GBZ = serialize::load_from(&args[1]).unwrap();
    let min: i64 = args[3].parse().unwrap();
    let metadata = graph.metadata().unwrap();
    for path in 0..metadata.paths() {
        let name = metadata.path(path).unwrap();
        if metadata.sample_name(name.sample()) != args[2] {
            continue;
        }
        let mut at: HashMap<usize, (i64, i64)> = HashMap::new();
        let mut offset = 0i64;
        let walk: Vec<(usize, Orientation)> = graph.path(path, Orientation::Forward).unwrap().collect();
        for &(id, _) in walk.iter() {
            let len = graph.sequence_len(id).unwrap() as i64;
            at.entry(id).or_insert((offset, len));
            offset += len;
        }
        let contig = metadata.contig_name(name.contig());
        let mut seen: HashSet<(i64, i64)> = HashSet::new();
        for &(id, _) in walk.iter() {
            let (from, from_len) = at[&id];
            for orientation in [Orientation::Forward, Orientation::Reverse] {
                for (successor, _) in graph.successors(id, orientation).unwrap() {
                    if let Some(&(to, _)) = at.get(&successor) {
                        if to - (from + from_len) >= min && seen.insert((from, to)) {
                            println!("{}\t{}\t{}\t{}", contig, name.fragment(), from + from_len, to);
                        }
                    }
                }
            }
        }
    }
}
